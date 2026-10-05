// The demo against a live RPC: Monad testnet, or any node reachable over HTTP.
//
// The browser is unchanged. It still reads and writes through /rpc, still asks
// for `eth_accounts` and signs with `eth_sendTransaction`; this module answers
// those two calls itself (the keys are derived from DEMO_MNEMONIC and never
// leave the server) and forwards every read to the upstream RPC untouched. The
// price oracle that web/chain.mjs runs every block runs here as a transaction
// every few seconds, and only at that pace while somebody is looking.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, formatEther, formatUnits, getAddress, parseEther } from "ethers";
import { loadArtifact } from "../contracts/script/artifacts.mjs";
import { CONTRACT_SOURCES, START_BTC_PRICE, START_PRICE, deployDemoSystem } from "./mandates.mjs";
import { FAUCET_USDC, FaucetError, FaucetLimiter } from "./faucet.mjs";
import { demoWallets } from "./accounts.mjs";
import { authorise, authoriseTypedData, buildPolicy } from "./live-policy.mjs";
import { RollingBudget, gasLimitFor, perKeyQueue, planTopUps } from "./live-gas.mjs";
import { createBatchDesk, createReporterDesk, gasGate, refuse } from "./live-desks.mjs";
import { intentDomain, intentTypes } from "../contracts/tools/batch.mjs";
import { DPReporter } from "../reporter/reporter.mjs";
import {
  MULTICALL3, ReadCache, packCalls, packable, rpcFailure, rpcResult, sendPatiently, toRpcError, unpackAnswers
} from "./rpc.mjs";

const root = path.resolve(import.meta.dirname, "..");

// Comparing secrets with !== leaks their length and contents through timing.
// Hashing both sides to a fixed-length digest first means timingSafeEqual
// never sees two differently-sized buffers, so there is no early-return case
// to avoid.
function timingSafeStringEqual(a, b) {
  const digestA = createHash("sha256").update(String(a ?? "")).digest();
  const digestB = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(digestA, digestB);
}

export const NETWORKS = {
  143: { label: "Monad mainnet", explorer: "https://monadscan.com" },
  10143: { label: "Monad testnet", explorer: "https://testnet.monadscan.com" },
  31337: { label: "Local node", explorer: null }
};
export const networkInfo = (chainId) => NETWORKS[chainId] ?? { label: `Chain ${chainId}`, explorer: null };
export const deploymentFileFor = (chainId) => path.join(root, "web/deployments", `${chainId}.json`);

export function loadAbis() {
  return Object.fromEntries(
    Object.entries(CONTRACT_SOURCES).map(([key, [source, name]]) => [key, loadArtifact(`${source}.sol`, name).abi])
  );
}

// Everything the page needs to read a chain. Anything else - signing methods,
// node administration, raw transaction relay - is refused at the proxy.
// The server's own reads, estimates and sends share the upstream quota with
// every visitor's reads. ethers waits out an HTTP 429 by itself; inside a batch
// the refusal arrives per call under a 200, and those are sent again here.
class PatientProvider extends JsonRpcProvider {
  async _send(payload) {
    const calls = Array.isArray(payload) ? payload : [payload];
    const answers = await sendPatiently(calls, (batch) => super._send(batch.length === 1 ? batch[0] : batch));
    return answers.filter(Boolean);
  }
}

const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call",
  "eth_estimateGas", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getTransactionCount", "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "net_version", "web3_clientVersion"
]);

class TokenBucket {
  constructor(perMinute) {
    this.capacity = perMinute;
    this.tokens = perMinute;
    this.updated = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 60_000) * this.capacity);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ethers reports an RPC error it does not recognise as "could not coalesce
// error" and keeps what the node said underneath; the log wants both.
const describe = (error) => {
  const short = error?.shortMessage ?? error?.message ?? String(error);
  const said = error?.info?.error?.message ?? error?.error?.message;
  return said && !short.includes(said) ? `${short} (${said})` : short;
};
const isOutOfGasMoney = (error) => /insufficient|balance|funds/i.test(describe(error));
// What each demo account is filled to, and the level under which it is refilled.
// Monad bills the signed limit, so one trade costs about 0.04 MON at 100 gwei:
// the floor leaves room for a few more clicks before the refill has landed.
export const GAS_PER_ACCOUNT_MON = 0.4;
const GAS_FLOOR_MON = 0.2;
// How often the deployer looks at the demo accounts' balances while watched,
// and how soon after one of them has signed.
const FUND_CHECK_MS = 10_000;
const FUND_RECHECK_MS = 2_000;
const STATUS_SHARE_MS = 1_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tops every demo account up to `perAccountMon` of gas from the owner. Only the
// shortfall is sent, so re-running is cheap.
export async function fundAccounts({ provider, wallets, owner, perAccountMon, log = () => {} }) {
  const target = parseEther(String(perAccountMon));
  const recipients = [wallets.allocator, ...wallets.agents, wallets.keeper];
  for (const wallet of recipients) {
    const balance = await provider.getBalance(wallet.address);
    if (balance >= target) continue;
    const value = target - balance;
    await (await owner.sendTransaction({ to: wallet.address, value })).wait();
    log(`funded ${wallet.address} with ${formatEther(value)} MON`);
  }
}

// Deploys the four-mandate system from the demo accounts and records it in
// web/deployments/<chainId>.json (addresses only; ABIs come from the artifacts).
export async function deployLiveSystem({ provider, wallets, signers, file, perAccountMon = GAS_PER_ACCOUNT_MON, log = () => {} }) {
  await fundAccounts({ provider, wallets, owner: signers.owner, perAccountMon, log });
  const deploy = async (source, name, args = []) => {
    const { abi, bytecode } = loadArtifact(`${source}.sol`, name);
    const contract = await new ContractFactory(abi, bytecode, signers.owner).deploy(...args);
    await contract.waitForDeployment();
    log(`${name} ${await contract.getAddress()}`);
    return contract;
  };
  const abiOf = (source, name) => loadArtifact(`${source}.sol`, name).abi;
  const record = await deployDemoSystem({
    deploy, abiOf, provider,
    owner: signers.owner, allocator: signers.allocator, agents: signers.agents, keeper: signers.keeper,
    basePriceE18: START_PRICE, profile: "live", log
  });
  const { abis: _abis, ...rest } = record;
  const stored = { ...rest, deployedAt: new Date().toISOString(), network: networkInfo(rest.chainId) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  log(`wrote ${path.relative(root, file)}`);
  return stored;
}

export async function startLive({ rpcUrl, mnemonic, adminToken = "", deploymentFile, env = process.env, log = console.log }) {
  if (!rpcUrl) throw new Error("MONAD_RPC_URL is required in live mode");
  if (!mnemonic) throw new Error("DEMO_MNEMONIC is required in live mode");
  const number = (key, fallback) => (env[key] === undefined || env[key] === "" ? fallback : Number(env[key]));
  const config = {
    activeSeconds: number("ORACLE_ACTIVE_SECONDS", 5),
    idleSeconds: number("ORACLE_IDLE_SECONDS", 300),
    observeSeconds: number("ORACLE_OBSERVE_SECONDS", 60),
    presenceSeconds: number("PRESENCE_SECONDS", 60),
    autoReset: env.AUTO_RESET !== "0",
    autoResetMinFrozen: number("AUTO_RESET_MIN_FROZEN", 2),
    resetCooldownSeconds: number("RESET_COOLDOWN_SECONDS", 600),
    resetMinBalanceMon: number("RESET_MIN_BALANCE_MON", 3),
    gasPerAccountMon: number("DEMO_GAS_PER_ACCOUNT_MON", GAS_PER_ACCOUNT_MON),
    gasFloorMon: number("DEMO_GAS_FLOOR_MON", GAS_FLOOR_MON),
    topUpPerHourMon: number("DEMO_TOPUP_PER_HOUR_MON", 6),
    ownerReserveMon: number("OWNER_RESERVE_MON", 1),
    maxGasPerTx: number("MAX_GAS_PER_TX", 1_500_000),
    gasHeadroomPercent: number("GAS_HEADROOM_PERCENT", 50),
    txTimeoutSeconds: number("TX_TIMEOUT_SECONDS", 20),
    sendPerMinute: number("SEND_TX_PER_MINUTE", 40),
    controlPerMinute: number("CONTROL_PER_MINUTE", 12),
    logLookbackBlocks: number("LOG_LOOKBACK_BLOCKS", 90),
    readCacheMs: number("READ_CACHE_MS", 2000),
    packReads: env.PACK_READS !== "0"
  };

  const provider = new PatientProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 500;
  const chainId = Number((await provider.getNetwork()).chainId);
  const canPack = config.packReads && (await provider.getCode(MULTICALL3)) !== "0x";
  const file = deploymentFile ?? deploymentFileFor(chainId);
  const wallets = demoWallets(mnemonic, provider);
  // Local nonces for every account that sends: a load-balanced public RPC can
  // answer eth_getTransactionCount from a node that has not seen the last one.
  const signers = {
    owner: new NonceManager(wallets.owner),
    allocator: new NonceManager(wallets.allocator),
    agents: wallets.agents.map((w) => new NonceManager(w)),
    keeper: new NonceManager(wallets.keeper)
  };
  const abis = loadAbis();
  const sendBucket = new TokenBucket(config.sendPerMinute);
  const controlBucket = new TokenBucket(config.controlPerMinute);
  const reads = new ReadCache(config.readCacheMs);
  let forwarded = 0;
  let packed = 0;
  let reading = { at: 0, value: null, pending: null }; // see chainReading()

  let deployment = null;
  let policy = null;
  let hot = new Map();
  let venue = null;
  let guard = null;
  let vaults = [];

  function adopt(record) {
    if (Number(record.chainId) !== chainId) {
      throw new Error(`${file} is a chain ${record.chainId} deployment; the RPC is chain ${chainId}`);
    }
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const matches =
      same(record.accounts.allocator, wallets.allocator.address) &&
      same(record.accounts.keeper, wallets.keeper.address) &&
      record.vaults.every((v, i) => same(v.agent, wallets.agents[i].address));
    if (!matches) throw new Error("DEMO_MNEMONIC does not derive this deployment's accounts; run npm run deploy:demo");

    deployment = { ...record, abis, live: true, network: networkInfo(chainId) };
    policy = buildPolicy(deployment);
    hot = new Map([
      [wallets.allocator.address.toLowerCase(), signers.allocator],
      [wallets.keeper.address.toLowerCase(), signers.keeper],
      ...wallets.agents.map((w, i) => [w.address.toLowerCase(), signers.agents[i]])
    ]);
    venue = new Contract(deployment.addresses.venue, abis.venue, signers.owner);
    guard = new Contract(deployment.addresses.guard, abis.guard, signers.keeper);
    vaults = deployment.vaults.map((v) => new Contract(v.address, abis.vault, provider));
  }

  if (!fs.existsSync(file)) {
    throw new Error(`No deployment at ${path.relative(root, file)}. Run \`npm run deploy:demo\` against this RPC first.`);
  }
  adopt(JSON.parse(fs.readFileSync(file, "utf8")));

  // --- presence and the oracle ----------------------------------------
  let basePriceE18 = START_PRICE;
  let pendingShockBps = 0;
  let lastTouch = 0;
  let wasActive = false;
  let lastPushAt = 0;
  let lastObserveAt = 0;
  let lastResetAt = 0;
  let ticks = 0;
  let pushes = 0;
  let spentWei = 0n;
  let lastError = null;
  let busy = false;
  let resets = 0; // redeploys in progress
  const jobs = new Map(); // work running beside the beat, by kind
  let lastFundCheckAt = 0;
  let toppedUpWei = 0n;
  let gasWarning = null;
  const topUpBudget = new RollingBudget(parseEther(String(config.topUpPerHourMon)), 3_600_000);

  const touch = () => { lastTouch = Date.now(); };
  const isActive = () => Date.now() - lastTouch < config.presenceSeconds * 1000;
  // Monad bills the gas limit, not the gas used, so that is what gets counted.
  const spend = (response, receipt) => { spentWei += response.gasLimit * (receipt.gasPrice ?? response.gasPrice ?? 0n); };

  // NonceManager counts a transaction as sent before it is. When the send then
  // fails (no balance left, a refused estimate), the nonce it reserved is never
  // used and every later transaction from that account waits behind the gap. So
  // any failure drops the local count and the next send asks the chain again,
  // and an account sends one at a time: a failure beside a second send already
  // on its way would leave that one signed past the gap.
  const inOrder = perKeyQueue();
  function submit(signer, makeCall) {
    return inOrder(signer, async () => {
      try {
        return await makeCall();
      } catch (error) {
        signer.reset();
        throw error;
      }
    });
  }
  // A transaction the chain never includes must not hold the oracle forever.
  async function settle(signer, response) {
    try {
      const receipt = await response.wait(1, config.txTimeoutSeconds * 1000);
      spend(response, receipt);
      return receipt;
    } catch (error) {
      if (error?.receipt) spend(response, error.receipt); // mined and reverted: billed, nonce used
      else await inOrder(signer, () => signer.reset()); // never included: count again from the chain
      throw error;
    }
  }
  const send = async (signer, makeCall) => settle(signer, await submit(signer, makeCall));
  // The server's own calls carry the headroom too. What a call costs depends on
  // what is mined just before it: an observe estimated while the vault has
  // already seen the current mark writes nothing, and the same call after the
  // next mark writes the estimate, about a tenth more gas.
  async function padded(method, ...args) {
    const gas = await method.estimateGas(...args);
    return method(...args, { gasLimit: gasLimitFor(gas, config.gasHeadroomPercent, config.maxGasPerTx) });
  }

  // The round is submitted back to back and confirmed together, so four vaults
  // cost one confirmation's wait instead of four. Rounds never overlap.
  const observeLane = {};
  const observeAll = (why) => inOrder(observeLane, () => observeRound(why));
  async function observeRound(why) {
    lastObserveAt = Date.now();
    let states;
    try {
      states = await Promise.all(vaults.map((v) => v.state()));
    } catch (error) {
      lastObserveAt = 0; // nothing was sent: the next beat tries the round again
      throw error;
    }
    const sent = [];
    for (const [index, vault] of deployment.vaults.entries()) {
      if (Number(vault.limits.volWindowSeconds) === 0) continue;
      // A frozen or closed vault takes no more orders, so nothing reads its estimate.
      if (states[index] !== 0n) continue;
      try {
        const response = await submit(signers.keeper, () => padded(guard.observe, vault.address, deployment.addresses.adapter));
        sent.push({ vault, response });
      } catch (error) {
        log(`[observe:${why}] ${vault.key} ${describe(error)}`);
        if (isOutOfGasMoney(error)) lastFundCheckAt = 0;
        break; // the keeper's nonce was just dropped; the next round starts clean
      }
    }
    await Promise.all(sent.map(async ({ vault, response }) => {
      try {
        await settle(signers.keeper, response);
      } catch (error) {
        log(`[observe:${why}] ${vault.key} ${describe(error)}`);
      }
    }));
    reads.clear();
  }

  // The demo accounts are funded when the book is deployed and spend from then
  // on: the keeper's observes alone are about 0.06 MON a minute while somebody
  // is watching. The deployer refills whichever account drops under the floor,
  // within an hourly allowance (a visitor hammering the buttons cannot drain
  // it) and never below its own reserve (the oracle has to keep marking).
  async function topUpAccounts() {
    lastFundCheckAt = Date.now();
    const recipients = [wallets.allocator, ...wallets.agents, wallets.keeper];
    const [ownerBalance, ...balances] = await Promise.all(
      [wallets.owner, ...recipients].map((w) => provider.getBalance(w.address))
    );
    const floor = parseEther(String(config.gasFloorMon));
    const reserve = parseEther(String(config.ownerReserveMon));
    const spare = ownerBalance > reserve ? ownerBalance - reserve : 0n;
    const allowance = topUpBudget.left();
    const plan = planTopUps(
      recipients.map((w, i) => ({ address: w.address, balance: balances[i] })),
      { floor, target: parseEther(String(config.gasPerAccountMon)), available: spare < allowance ? spare : allowance }
    );
    const low = balances.filter((b) => b < floor).length;
    const warning = low > plan.length
      ? `${low - plan.length} demo account(s) are low on gas and ${spare < allowance ? "the deployer is down to its reserve" : "the hourly refill allowance is used up"}`
      : null;
    if (warning && warning !== gasWarning) log(`[gas] ${warning}`);
    gasWarning = warning;

    const sent = [];
    for (const { address, value } of plan) {
      try {
        // A plain transfer to a key is always 21,000 gas; no estimate needed.
        const response = await submit(signers.owner, () => signers.owner.sendTransaction({ to: address, value, gasLimit: 21_000n }));
        sent.push({ address, value, response });
      } catch (error) {
        log(`[gas] refill of ${address} failed: ${describe(error)}`);
        break;
      }
    }
    await Promise.all(sent.map(async ({ address, value, response }) => {
      try {
        await settle(signers.owner, response);
        topUpBudget.spend(value);
        toppedUpWei += value;
        log(`[gas] refilled ${address} with ${formatEther(value)} MON`);
      } catch (error) {
        log(`[gas] refill of ${address} failed: ${describe(error)}`);
      }
    }));
    if (sent.length) reads.clear();
  }

  async function push() {
    const startedAt = Date.now();
    ticks += 1;
    const wobbleBps = Math.round(8 * Math.sin(ticks / 9));
    const priceE18 = (basePriceE18 * BigInt(10_000 + wobbleBps)) / 10_000n;
    if (deployment.addresses.factory) {
      // A book with the factory has a two-market venue: both marks go in one
      // transaction, so a BTC mark is as fresh as the ETH one for the same gas
      // overhead. Shocks move ETH only.
      const btcWobbleBps = Math.round(6 * Math.sin(ticks / 7 + 1));
      const btcE18 = (START_BTC_PRICE * BigInt(10_000 + btcWobbleBps)) / 10_000n;
      await send(signers.owner, () => padded(venue.setPrices, [priceE18, btcE18]));
    } else {
      await send(signers.owner, () => padded(venue.setPrice, priceE18));
    }
    reads.clear();
    reading = { at: 0, value: reading.value, pending: null };
    pushes += 1;
    // From the start of the send: the cadence is mark to mark. Counted from the
    // confirmation, each mark would come a confirmation's wait later than the last.
    lastPushAt = startedAt;
  }

  async function applyShock() {
    // Take the pre-shock mark first so the estimator sees the shock as one
    // return over a block or two, as it does on the in-process chain.
    if (isActive()) await observeAll("pre-shock");
    basePriceE18 = (basePriceE18 * BigInt(10_000 + pendingShockBps)) / 10_000n;
    pendingShockBps = 0;
    await push();
    if (isActive()) await observeAll("post-shock");
  }

  // Observe rounds, refills and shocks run beside the beat, one of each kind at
  // a time. Run inside it, they delayed the next mark by seconds, and a mandate
  // with a 10 second mark-age limit then refused orders on a healthy oracle.
  function runJob(kind, job) {
    if (jobs.has(kind) || resets > 0) return;
    const run = job()
      .catch((error) => {
        lastError = describe(error);
        log(`[${kind}] ${lastError}`);
      })
      .finally(() => jobs.delete(kind));
    jobs.set(kind, run);
  }
  // A redeploy replaces every contract the jobs talk to: they finish first and
  // no new one starts until it is done.
  async function whileReset(task) {
    resets += 1;
    try {
      await Promise.all(jobs.values());
      return await task();
    } finally {
      resets -= 1;
    }
  }

  async function maybeAutoReset() {
    const states = await Promise.all(vaults.map((v) => v.state()));
    const frozen = states.filter((s) => s !== 0n).length;
    if (frozen < config.autoResetMinFrozen) return;
    if (Date.now() - lastResetAt < config.resetCooldownSeconds * 1000) return;
    const balance = await provider.getBalance(wallets.owner.address);
    if (balance < parseEther(String(config.resetMinBalanceMon))) {
      log(`[reset] skipped: ${frozen} vaults frozen but owner holds ${formatEther(balance)} MON`);
      return;
    }
    log(`[reset] ${frozen} vaults frozen: redeploying`);
    await redeploy("auto");
  }

  async function beat() {
    if (busy || resets > 0 || !deployment) return;
    busy = true;
    try {
      const active = isActive();
      const justLeft = wasActive && !active;
      // Vaults can also be frozen while nobody watches (freezeUnobservable after
      // an idle stretch), so check on arrival too, not only after a departure.
      const justArrived = !wasActive && active;
      wasActive = active;
      if ((justLeft || justArrived) && config.autoReset) await whileReset(maybeAutoReset);
      if (pendingShockBps !== 0) runJob("shock", applyShock);
      if (active && Date.now() - lastFundCheckAt >= FUND_CHECK_MS) runJob("gas", topUpAccounts);

      const cadence = (active ? config.activeSeconds : config.idleSeconds) * 1000;
      if (Date.now() - lastPushAt < cadence) return;
      await push();
      // The mark just moved every vault's NAV: one sample for the reporter.
      runJob("sample", async () => desk("reporter")?.sample());
      if (active && Date.now() - lastObserveAt >= config.observeSeconds * 1000) runJob("observe", () => observeAll("tick"));
      lastError = null;
    } catch (error) {
      lastError = describe(error);
      log(`[oracle] ${lastError}`);
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(beat, 1000);

  async function redeploy(by) {
    lastResetAt = Date.now();
    basePriceE18 = START_PRICE;
    pendingShockBps = 0;
    lastPushAt = 0;
    lastObserveAt = 0;
    // A deploy sends from every demo account: start each from the chain's count,
    // and leave none with a local count that a failed deploy got ahead of.
    const all = [signers.owner, signers.allocator, signers.keeper, ...signers.agents];
    for (const signer of all) signer.reset();
    let stored;
    try {
      stored = await deployLiveSystem({
        provider, wallets, signers, file, perAccountMon: config.gasPerAccountMon, log: (line) => log(`[deploy:${by}] ${line}`)
      });
    } catch (error) {
      for (const signer of all) signer.reset();
      throw error;
    }
    adopt(stored);
    reads.clear();
    reading = { at: 0, value: null, pending: null };
    // The cooldown counts from the end of a reset, not its start.
    lastResetAt = Date.now();
    return deployment;
  }

  // --- JSON-RPC ---------------------------------------------------------
  async function post(batch) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch)
    });
    if (response.status === 429) return batch.map((call) => rpcFailure(call.id, -32011, "upstream rate limit"));
    if (!response.ok) throw new Error(`upstream RPC answered ${response.status}`);
    const answers = await response.json();
    // One error object for the whole batch: it is every call's answer.
    return Array.isArray(answers) ? answers : batch.map((call) => ({ ...answers, id: call.id }));
  }

  // The reads that have to leave for the upstream RPC, answered in call order.
  // Where the chain has Multicall3, the plain contract reads of a page refresh
  // go as one eth_call instead of thirty.
  async function upstream(calls) {
    const slots = calls.map((_, slot) => slot);
    const noAnswer = () => rpcFailure(null, -32603, "no answer from upstream");
    const direct = async (wanted) => {
      forwarded += wanted.length;
      const replies = await sendPatiently(wanted.map((slot) => ({ ...calls[slot], id: slot })), post);
      return replies.map((reply) => reply ?? noAnswer());
    };
    const bundle = canPack ? slots.filter((slot) => packable(calls[slot])) : [];
    if (bundle.length < 2) return direct(slots);

    const answers = new Array(calls.length);
    const rest = slots.filter((slot) => !bundle.includes(slot));
    const bundled = bundle.map((slot) => calls[slot]);
    forwarded += 1;
    const [restAnswers, [reply]] = await Promise.all([
      direct(rest),
      sendPatiently([packCalls(bundled, "pack")], post)
    ]);
    for (const [at, slot] of rest.entries()) answers[slot] = restAnswers[at];
    // A bundle that failed as a whole says nothing about its reads: ask for them one by one.
    const unpacked = unpackAnswers(bundled, reply);
    if (unpacked) packed += bundle.length;
    for (const [at, answer] of (unpacked ?? (await direct(bundle))).entries()) answers[bundle[at]] = answer;
    return answers;
  }

  async function sendOnBehalf(id, tx) {
    const verdict = authorise(policy, tx);
    if (!verdict.ok) return rpcFailure(id, -32000, `refused: ${verdict.reason}`);
    if (resets > 0) return rpcFailure(id, -32000, "refused: the demo is being reset; try again in a few seconds");
    if (!sendBucket.take()) return rpcFailure(id, -32005, "the demo is signing too many transactions; try again in a minute");
    const signer = hot.get(String(tx.from).toLowerCase());
    const request = { to: tx.to, data: tx.data ?? tx.input, value: 0n };
    let gas;
    try {
      // The browser's gas field is ignored: Monad charges the limit, so the
      // server estimates for itself and caps what one click can cost. A call
      // that would revert stops here, with its custom error, and costs nothing.
      gas = await provider.estimateGas({ ...request, from: tx.from });
    } catch (error) {
      return { jsonrpc: "2.0", id, error: toRpcError(error) };
    }
    if (gas > BigInt(config.maxGasPerTx)) return rpcFailure(id, -32000, `refused: gas ${gas} is above the demo cap`);
    try {
      const gasLimit = gasLimitFor(gas, config.gasHeadroomPercent, config.maxGasPerTx);
      const response = await submit(signer, () => signer.sendTransaction({ ...request, gasLimit }));
      const landed = () => {
        reads.clear();
        desks.batch?.refresh();
      };
      settle(signer, response).then(landed, landed);
      // This account just spent: look at the balances soon rather than at the next regular check.
      lastFundCheckAt = Math.min(lastFundCheckAt, Date.now() - FUND_CHECK_MS + FUND_RECHECK_MS);
      touch();
      log(`[sign] ${verdict.role} ${verdict.name} -> ${response.hash}`);
      return rpcResult(id, response.hash);
    } catch (error) {
      if (isOutOfGasMoney(error)) {
        lastFundCheckAt = 0; // refill on the next beat rather than at the next check
        return rpcFailure(id, -32000, "refused: this demo account is out of gas; it is refilled within a few seconds, try again");
      }
      return { jsonrpc: "2.0", id, error: toRpcError(error) };
    }
  }

  // The page signs an AllocationIntent the way it would ask a wallet to. The
  // allocator's key is here, so the request is checked like a transaction is:
  // this deployment's batch allocator, the allocator's own intent, a vault of
  // this book. No other typed data is ever signed.
  async function signIntent(id, params) {
    const [address, payload] = Array.isArray(params) ? params : [];
    const verdict = authoriseTypedData(policy, address, payload);
    if (!verdict.ok) return rpcFailure(id, -32000, `refused: ${verdict.reason}`);
    if (resets > 0) return rpcFailure(id, -32000, "refused: the demo is being reset; try again in a few seconds");
    if (!sendBucket.take()) return rpcFailure(id, -32005, "the demo is signing too many transactions; try again in a minute");
    try {
      const domain = intentDomain(deployment.chainId, deployment.batch.address);
      const signature = await wallets.allocator.signTypedData(domain, intentTypes, verdict.intent);
      touch();
      log(`[sign] allocator intent: epoch ${verdict.intent.epoch}, vault ${verdict.intent.vault}`);
      return rpcResult(id, signature);
    } catch (error) {
      return { jsonrpc: "2.0", id, error: toRpcError(error) };
    }
  }

  // --- batcher and reporter ---------------------------------------------
  // The server is the batcher and the reporter of a live book, and the deployer
  // pays for both (web/live-desks.mjs). One desk of each per deployment: a reset
  // drops the queued intents and the claim proofs with the contracts they were for.
  const deskBudget = new RollingBudget(BigInt(Math.trunc(number("DESK_GAS_PER_HOUR", 10_000_000))), 3_600_000);
  const settleBucket = new TokenBucket(number("SETTLE_PER_MINUTE", 3));
  // The seed of a release's noise. Whoever knows it can take the noise back out.
  const reporterSecret = env.DEMO_REPORTER_SECRET || randomBytes(32);
  let desks = { of: null, batch: null, reporter: null };
  function desk(name) {
    if (desks.of !== deployment) desks = { of: deployment, ...openDesks() };
    return desks[name];
  }
  // A settlement or a release in flight is a job like the oracle's: a reset
  // waits for it to land, and none is sent once a reset has begun.
  const ownerSends = (kind) => (makeCall) => {
    if (resets > 0) throw refuse("the demo is being reset; try again in a few seconds", 409);
    const run = send(signers.owner, makeCall).finally(() => reads.clear());
    const tracked = run.then(() => {}, () => {}).finally(() => {
      if (jobs.get(kind) === tracked) jobs.delete(kind);
    });
    jobs.set(kind, tracked);
    touch();
    return run;
  };
  function openDesks() {
    const resetting = () => resets > 0;
    const headroomPercent = config.gasHeadroomPercent;
    const addresses = deployment.vaults.map((vault) => vault.address);
    const abi = deployment.abis ?? loadAbis();
    let batch = null;
    let reporter = null;
    if (deployment.batch?.address) {
      const { address, genesis, epochDuration, settlementWindow } = deployment.batch;
      const states = new Map(addresses.map((vault) => [vault.toLowerCase(), new Contract(vault, abi.vault, provider)]));
      batch = createBatchDesk({
        domain: intentDomain(deployment.chainId, address),
        timing: { genesis: Number(genesis), epochDuration: Number(epochDuration), settlementWindow: Number(settlementWindow) },
        vaults: addresses,
        batch: new Contract(address, abi.batch, signers.owner),
        vaultState: (vault) => states.get(vault.toLowerCase()).state(),
        chainTime: async () => Number((await chainReading())[2].timestamp),
        send: ownerSends("settle"),
        admit: gasGate({
          what: "a settlement", cap: number("SETTLE_MAX_GAS", 2_000_000), headroomPercent, budget: deskBudget, bucket: settleBucket
        }),
        limits: { maxPerEpoch: number("BATCH_MAX_PER_EPOCH", 8), maxPending: number("BATCH_MAX_PENDING", 32) },
        describe, resetting, log
      });
    }
    if (deployment.registry?.address) {
      const { address, clipBound, epsilon } = deployment.registry;
      const quotes = new Contract(deployment.addresses.guard, abi.guard, provider);
      reporter = createReporterDesk({
        registry: new Contract(address, abi.registry, signers.owner),
        address,
        reporter: new DPReporter({
          reporterSecret, signer: wallets.owner, registryAddress: address, chainId: deployment.chainId, clipBound, epsilon
        }),
        vaults: addresses,
        navOf: async (vault) => Number(formatUnits((await quotes.quote(vault, deployment.addresses.adapter))[0], 18)),
        blockNumber: () => provider.getBlockNumber(),
        send: ownerSends("release"),
        admit: gasGate({ what: "a release", cap: config.maxGasPerTx, headroomPercent, budget: deskBudget }),
        settings: { clipBound, epsilon },
        limits: { minIntervalSeconds: number("REPORT_MIN_SECONDS", 120) },
        describe, resetting, log
      });
    }
    return { batch, reporter };
  }

  async function handleOne(call) {
    const id = call?.id ?? null;
    const method = call?.method;
    if (method === "eth_accounts") return rpcResult(id, policy.accounts);
    if (method === "eth_sendTransaction") return sendOnBehalf(id, (call.params ?? [])[0]);
    if (method === "eth_signTypedData_v4") return signIntent(id, call.params);
    if (!READ_METHODS.has(method)) return rpcFailure(id, -32601, `${method} is not available through the demo proxy`);
    return null;
  }

  async function handleRpc(payload) {
    touch();
    const calls = Array.isArray(payload) ? payload : [payload];
    const results = new Array(calls.length);
    const forward = [];
    for (const [index, call] of calls.entries()) {
      const handled = (await handleOne(call)) ?? reads.get(call);
      if (handled) results[index] = handled;
      else forward.push(index);
    }
    if (forward.length) {
      try {
        const answers = await upstream(forward.map((index) => calls[index]));
        for (const [at, index] of forward.entries()) results[index] = { ...answers[at], id: calls[index].id ?? null };
        // A mined receipt passing through means the state the cache holds is
        // from before that transaction; the browser that sent it is about to
        // re-read everything and must not get the old answers.
        if (forward.some((index) => calls[index].method === "eth_getTransactionReceipt" && results[index].result)) reads.clear();
        for (const index of forward) reads.put(calls[index], results[index]);
      } catch (error) {
        for (const index of forward) results[index] = rpcFailure(calls[index].id ?? null, -32603, error.message);
      }
    }
    return Array.isArray(payload) ? results : results[0];
  }

  // The chain half of a status answer. Every open page asks for it every few
  // seconds and every control click once more, so one reading serves a second
  // of them, and the previous one stands in while the upstream is refusing.
  function chainReading() {
    const mine = reading;
    if (mine.value && Date.now() - mine.at < STATUS_SHARE_MS) return mine.value;
    mine.pending ??= Promise.all([
      venue.priceE18(), venue.updatedAt(), provider.getBlock("latest"), provider.getBalance(wallets.owner.address)
    ]).then(
      (value) => {
        Object.assign(mine, { at: Date.now(), value, pending: null });
        return value;
      },
      (error) => {
        mine.pending = null;
        if (mine.value) return mine.value;
        throw error;
      }
    );
    return mine.pending;
  }

  const control = {
    async status() {
      const [priceE18, markedAt, block, balance] = await chainReading();
      const active = isActive();
      const cadenceSeconds = active ? config.activeSeconds : config.idleSeconds;
      return {
        live: true,
        blockTimeSeconds: null,
        priceE18: priceE18.toString(),
        markedAt: Number(markedAt),
        chainTime: Number(block.timestamp),
        basePrice: formatUnits(basePriceE18, 18),
        oracle: {
          active,
          cadenceSeconds,
          observeSeconds: config.observeSeconds,
          lastPushAt,
          nextPushInSeconds: lastPushAt ? Math.max(0, Math.round((lastPushAt + cadenceSeconds * 1000 - Date.now()) / 1000)) : 0,
          pushes,
          spentMon: formatEther(spentWei),
          lastError
        },
        deployer: { address: wallets.owner.address, balanceMon: formatEther(balance) },
        gas: {
          perAccountMon: config.gasPerAccountMon,
          floorMon: config.gasFloorMon,
          headroomPercent: config.gasHeadroomPercent,
          toppedUpMon: formatEther(toppedUpWei),
          topUpLeftMon: formatEther(topUpBudget.left()),
          warning: gasWarning
        },
        proxy: { forwarded, packed, cached: reads.hits, cacheMs: config.readCacheMs, packing: canPack },
        // The guard is deployed anew by every reset: a page compares it with the
        // one it booted on to notice a reset it did not ask for.
        reset: { admin: Boolean(adminToken), auto: config.autoReset, lastResetAt, guard: deployment?.addresses.guard ?? null }
      };
    },
    setBlockTime() {
      throw new Error("block time is the chain's own on a live network");
    },
    shock(bps) {
      if (!controlBucket.take()) throw new Error("too many market moves; wait a minute");
      const value = Math.trunc(Number(bps));
      if (!Number.isFinite(value) || Math.abs(value) > 3000) throw new Error("shock out of range");
      touch();
      pendingShockBps = value;
      return { pendingShockBps };
    },
    restorePrice() {
      if (!controlBucket.take()) throw new Error("too many market moves; wait a minute");
      touch();
      basePriceE18 = START_PRICE;
      pendingShockBps = 0;
      lastPushAt = 0; // push on the next beat
      return { basePrice: formatUnits(basePriceE18, 18) };
    },
    async redeploy(token) {
      if (!adminToken || !timingSafeStringEqual(token, adminToken)) {
        throw new Error("reset needs the admin token on a live network");
      }
      return whileReset(async () => {
        while (busy) await pause(50); // the mark in flight lands first
        if (Date.now() - lastResetAt < config.resetCooldownSeconds * 1000) {
          throw new Error(`reset cooldown: ${Math.ceil((lastResetAt + config.resetCooldownSeconds * 1000 - Date.now()) / 1000)}s left`);
        }
        await redeploy("admin");
        return { ok: true, startedAt: deployment.startedAt };
      });
    }
  };

  // --- faucet ---------------------------------------------------------
  //
  // A visitor's own wallet holds no mock USDC. The owner mints some, inside the
  // limiter's per-address and per-IP windows, and sends native gas only when
  // the operator sets FAUCET_NATIVE_WEI (0 by default: the deployer's MON is
  // the demo's whole budget, so giving it away is the team's call).
  const faucetLimiter = new FaucetLimiter({ perIp: number("FAUCET_PER_IP", 3) });
  const faucetNativeWei = BigInt(process.env.FAUCET_NATIVE_WEI ?? "0");
  const faucet = {
    async drip({ address, ip }) {
      if (!deployment.addresses.factory) {
        throw new FaucetError("this book predates open registration; the faucet opens on the next deployment", 404);
      }
      faucetLimiter.take(address, ip);
      const to = getAddress(String(address));
      try {
        const abi = deployment.abis ?? loadAbis();
        const usdc = new Contract(deployment.addresses.usdc, abi.usdc, signers.owner);
        const receipt = await ownerSends("faucet")(() => padded(usdc.mint, to, FAUCET_USDC));
        if (faucetNativeWei > 0n) {
          await ownerSends("faucet")(() => signers.owner.sendTransaction({ to, value: faucetNativeWei }));
        }
        log(`[faucet] ${to} received test USDC`);
        return { address: to, usdc: FAUCET_USDC.toString(), native: faucetNativeWei.toString(), txHash: receipt?.hash ?? null };
      } catch (error) {
        faucetLimiter.release(address, ip);
        throw error;
      }
    }
  };

  log(`live mode on ${deployment.network.label} (chain ${chainId}); oracle ${config.activeSeconds}s while watched, ${config.idleSeconds}s idle`);

  return {
    live: true,
    // The page scans logs from startBlock. Near the tip, not the deployment
    // block: a getLogs over days of testnet blocks is refused by public RPCs.
    deployment: async () => {
      const latest = await provider.getBlockNumber();
      return {
        ...deployment,
        startBlock: Math.max(deployment.startBlock, latest - config.logLookbackBlocks),
        logRangeBlocks: config.logLookbackBlocks
      };
    },
    handleRpc,
    control,
    // Null on a deployment recorded before it had a batch allocator or a registry.
    get batch() {
      return desk("batch");
    },
    get reporter() {
      return desk("reporter");
    },
    faucet,
    touch,
    async close() {
      clearInterval(timer);
      provider.destroy();
    }
  };
}
