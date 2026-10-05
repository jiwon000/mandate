// A live server boots from web/deployments/<chainId>.json, the record that was
// committed. Its own resets write newer records to the server's disk, and a
// host that wipes the disk on restart (Render's free plan does) brings the
// server back on the committed record, which can be several books behind the
// chain. When that old book has frozen vaults, the first visitor to leave sets
// off yet another full redeploy, about 1.8 MON on Monad testnet.
//
// latestBook() finds the owner's newest complete book on chain instead, so a
// restart picks up where the last instance left off. It only reads: it walks
// the owner's CREATE addresses down from the current nonce and rebuilds each
// candidate book from the links between its contracts before trusting it.
import fs from "node:fs";
import path from "node:path";
import { Interface, getAddress, getCreateAddress } from "ethers";
import { NOTIONAL_LIMITS, REPORT_CLIP_BOUND, REPORT_EPSILON, mandatesFor, serialiseLimits } from "./mandates.mjs";

// The owner's nonces in one undisturbed deployDemoSystem() run, relative to the
// first contract it creates: USDC, guard, venue and adapter, then
// venue.setAdapter and the USDC mint; per vault the vault itself,
// guard.setAdapter, configure, lockTerms and a venue.setPrice; the batch
// allocator, one setVaultAllowed per vault; the registry last. Another owner
// transaction landing in between (an oracle mark) shifts the rest, so
// latestBook() only uses this for how far below the registry to look.
export function bookLayout(base, vaultCount) {
  const vaults = Array.from({ length: vaultCount }, (_, i) => base + 6 + 5 * i);
  const batch = base + 6 + 5 * vaultCount;
  return { usdc: base, guard: base + 1, venue: base + 2, adapter: base + 3, vaults, batch, registry: batch + 1 + vaultCount };
}

const iface = new Interface([
  "function asset() view returns (address)",
  "function riskGuard() view returns (address)",
  "function venueAdapter() view returns (address)",
  "function venue() view returns (address)",
  "function agent() view returns (address)",
  "function batcher() view returns (address)",
  "function owner() view returns (address)",
  "function reporter() view returns (address)",
  "function genesis() view returns (uint256)",
  "function epochDuration() view returns (uint256)",
  "function settlementWindow() view returns (uint256)",
  "function termsHash(address) view returns (bytes32)"
]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// ethers puts the endpoint's message in different places for a batch item, a
// failed eth_call and an HTTP 429.
const isRateLimit = (error) =>
  [error?.error?.message, error?.info?.error?.message, error?.info?.responseStatus, error?.message]
    .some((text) => /request limit|limited to|rate limit|429|too many/i.test(String(text ?? "")));

// Monad's public endpoint answers at most 15 eth_calls and 50 requests a
// second. `patient` spaces calls out to `perSecond` and retries a refusal for
// rate after a pause, so the walk is slow but never mistakes one for a revert.
export function patient(request, { perSecond = 12, tries = 6, waitMs = 1000 } = {}) {
  let next = 0;
  const slot = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / perSecond;
    if (at > now) await pause(at - now);
  };
  return async (args) => {
    for (let attempt = 1; ; attempt++) {
      await slot();
      try {
        return await request(args);
      } catch (error) {
        if (attempt >= tries || !isRateLimit(error)) throw error;
        await pause(waitMs * attempt);
      }
    }
  };
}

// `request` is an EIP-1193 style ({ method, params }) => result. At 12 reads a
// second the default `maxScan` takes about four minutes at worst; a restart
// after sleep usually finds the last book within a few hundred nonces.
export async function latestBook({ request: raw, record, maxScan = 3000, chunk = 12, perSecond, log = () => {} }) {
  const request = patient(raw, { perSecond });
  const owner = getAddress(record.accounts.owner);
  const mandates = mandatesFor(record.profile);
  const agents = record.vaults.map((v) => v.agent);
  if (agents.length !== mandates.length) return null;

  // A candidate that is not a book reverts on these getters; that only rules it out.
  const call = async (to, fn, args = []) => {
    try {
      return iface.decodeFunctionResult(fn, await request({ method: "eth_call", params: [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"] }))[0];
    } catch {
      return null;
    }
  };
  const hasCode = async (address) => (await request({ method: "eth_getCode", params: [address, "latest"] })) !== "0x";
  const at = (nonce) => getCreateAddress({ from: owner, nonce });

  const nonce = Number(await request({ method: "eth_getTransactionCount", params: [owner, "latest"] }));
  const floor = Math.max(0, nonce - maxScan);
  const span = bookLayout(0, mandates.length).registry;
  // Room for oracle marks that land between the deploy's own transactions.
  const slack = 60;

  // `top` is a candidate registry. The book under it is found by what each
  // contract points at, not by fixed offsets: the batch allocator is the
  // nearest contract below whose batcher is the owner, the vaults are the ones
  // run by the record's agents, and a vault names the USDC, guard and adapter.
  async function verify(top) {
    const registry = at(top);
    const [registryOwner, reporter] = await Promise.all([call(registry, "owner"), call(registry, "reporter")]);
    if (!same(registryOwner, owner) || !same(reporter, owner)) return null;
    const vaults = new Array(agents.length).fill(null);
    let batch = null;
    let links = null;
    let base = null;
    for (let n = top - 1; n >= Math.max(0, top - span - slack); n--) {
      const address = at(n);
      if (!(await hasCode(address))) continue;
      if (!batch) {
        if (same(await call(address, "batcher"), owner)) batch = address;
        continue;
      }
      if (vaults.includes(null)) {
        const agent = await call(address, "agent");
        const slot = agents.findIndex((x) => same(x, agent));
        if (slot < 0 || vaults[slot]) return null;
        const [asset, guard, adapter] = await Promise.all(["asset", "riskGuard", "venueAdapter"].map((fn) => call(address, fn)));
        if (links && !(same(asset, links.usdc) && same(guard, links.guard) && same(adapter, links.adapter))) return null;
        links ??= { usdc: asset, guard, adapter };
        vaults[slot] = address;
        continue;
      }
      if (same(address, links.usdc)) {
        base = n;
        break;
      }
    }
    if (!batch || vaults.includes(null) || base === null) return null;
    const venue = await call(links.adapter, "venue");
    const [batchAsset, guardOwner] = await Promise.all([call(batch, "asset"), call(links.guard, "owner")]);
    if (!venue || !(await hasCode(venue)) || !same(batchAsset, links.usdc) || !same(guardOwner, owner)) return null;
    return { a: { ...links, venue, batch, registry }, vaults, base };
  }

  // Walk down in chunks; the highest nonce whose CREATE address has code is the
  // newest book's registry, unless that run stopped part way.
  let reachedRecord = false;
  for (let top = nonce - 1; top >= floor + span; top -= chunk) {
    const nonces = Array.from({ length: Math.min(chunk, top - floor - span + 1) }, (_, i) => top - i);
    const addresses = nonces.map(at);
    if (record.addresses?.usdc && addresses.some((x) => same(x, record.addresses.usdc))) {
      const stop = addresses.findIndex((x) => same(x, record.addresses.usdc));
      nonces.length = stop;
      addresses.length = stop;
      reachedRecord = true;
    }
    const codes = await Promise.all(addresses.map(hasCode));
    for (const [i, n] of nonces.entries()) {
      if (!codes[i]) continue;
      const found = await verify(n);
      if (found && same(found.a.usdc, record.addresses?.usdc)) return record;
      if (found) return build(found);
    }
    if (reachedRecord) return null;
  }
  log(`no complete book in the owner's last ${maxScan} transactions`);
  return null;

  async function build({ a, vaults, base }) {
    // deployDemoSystem() takes startBlock just before the USDC deploy: the block
    // before the first one in which the owner's nonce has passed `base`.
    const latest = Number(await request({ method: "eth_blockNumber", params: [] }));
    let lo = Math.min(Number(record.startBlock) || 0, latest);
    let hi = latest;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const n = Number(await request({ method: "eth_getTransactionCount", params: [owner, `0x${mid.toString(16)}`] }));
      if (n > base) hi = mid;
      else lo = mid;
    }
    const block = await request({ method: "eth_getBlockByNumber", params: [`0x${hi.toString(16)}`, false] });
    const deployedMs = Number(block.timestamp) * 1000;
    const [genesis, epochDuration, settlementWindow] = await Promise.all(
      ["genesis", "epochDuration", "settlementWindow"].map((fn) => call(a.batch, fn))
    );
    const vaultRecords = [];
    for (const [i, mandate] of mandates.entries()) {
      vaultRecords.push({
        ...mandate,
        address: vaults[i],
        agent: getAddress(agents[i]),
        termsHash: await call(a.guard, "termsHash", [vaults[i]]),
        deposit: mandate.deposit.toString(),
        openSizeE18: mandate.openSizeE18.toString(),
        limits: serialiseLimits({ ...NOTIONAL_LIMITS, ...mandate.limits })
      });
    }
    if (vaultRecords.some((v) => !v.termsHash) || genesis === null) return null;
    return {
      chainId: record.chainId,
      profile: record.profile,
      addresses: { usdc: a.usdc, guard: a.guard, venue: a.venue, adapter: a.adapter },
      accounts: record.accounts,
      batch: { address: a.batch, genesis: Number(genesis), epochDuration: Number(epochDuration), settlementWindow: Number(settlementWindow) },
      registry: { address: a.registry, clipBound: REPORT_CLIP_BOUND, epsilon: REPORT_EPSILON },
      vaults: vaultRecords,
      startBlock: hi - 1,
      startedAt: deployedMs,
      deployedAt: new Date(deployedMs).toISOString(),
      network: record.network
    };
  }
}

// Rewrites `file` when the chain holds a newer complete book than the one it
// records. Never throws: on any failure the server boots from `file` as before.
export async function adoptLatestBook({ request, file, perSecond, log = () => {} }) {
  try {
    if (!fs.existsSync(file)) return false;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const found = await latestBook({ request, record, perSecond, log });
    if (!found || same(found.addresses.usdc, record.addresses?.usdc)) return false;
    fs.writeFileSync(file, `${JSON.stringify(found, null, 2)}\n`);
    log(`adopted the newer book deployed ${found.deployedAt} (USDC ${found.addresses.usdc}) into ${path.basename(file)}`);
    return true;
  } catch (error) {
    log(`could not look for a newer book, booting from the record: ${error?.shortMessage ?? error?.message ?? error}`);
    return false;
  }
}
