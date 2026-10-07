// Keeps a testnet deployment alive without the demo server.
//
// DeterministicMockVenue's mark is only as fresh as its last setPrice(), and the
// vault's guard refuses any mark older than maxMarkAgeSeconds. `npm run web:live`
// runs its own oracle while the page is served; this is the alternative for a
// deployment nobody is serving. Each tick nudges the price by a bounded random
// step, keeps it inside a band around the start price, and then pokes every
// vault so a drawdown breach is caught without anyone watching.
//
// Usage: MONAD_RPC_URL=... DEPLOYER_PRIVATE_KEY=... npm run keeper:monad
//   or   MONAD_RPC_URL=... DEMO_MNEMONIC="..."     npm run keeper:monad
// The key must be the venue's owner (setPrice is onlyOwner): the deployer of
// deploy.mjs, or account 0 of the demo mnemonic for deploy-demo.mjs.
// Reads contracts/deployments.latest.json (deploy.mjs, one vault) or
// web/deployments/<chainId>.json (deploy-demo.mjs, four vaults); DEPLOYMENT_FILE
// picks one explicitly. Do not run it next to `npm run web:live` on the same
// deployment: two oracles from one key fight over nonces.
//
// Watch-only: KEEPER_PRICE=0 never calls setPrice, so any funded key works (no
// venue ownership) against any venue, e.g. a Perpl-backed vault. It then sends a
// transaction only when it earns a bounty: poke() when a view says a term is
// breached, freezeUnobservable() once the mark is three ages old, unwind() on a
// Frozen vault. Vaults come from the deployment file plus, when the file names a
// MandateFactory, every vault that factory has made.
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, NonceManager, Wallet, formatUnits } from "ethers";
import { loadAbi } from "./artifacts.mjs";
import { describeActions, factoryVaults, keeperTick } from "./keeper-core.mjs";
import { demoWallets } from "../../web/accounts.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const {
  MONAD_RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  DEMO_MNEMONIC,
  DEPLOYMENT_FILE = "",
  KEEPER_INTERVAL_SECONDS = "10",
  KEEPER_DRIFT_BPS = "20",
  KEEPER_BAND_BPS = "1000",
  KEEPER_POKE = "1",
  KEEPER_PRICE = "1",
  KEEPER_ONCE = ""
} = process.env;
if (!MONAD_RPC_URL || !(DEPLOYER_PRIVATE_KEY || DEMO_MNEMONIC)) {
  throw new Error("Set MONAD_RPC_URL and DEPLOYER_PRIVATE_KEY or DEMO_MNEMONIC");
}
const watchOnly = KEEPER_PRICE === "0";

const provider = new JsonRpcProvider(MONAD_RPC_URL);
const chainId = (await provider.getNetwork()).chainId;
const wallet = DEPLOYER_PRIVATE_KEY
  ? new Wallet(DEPLOYER_PRIVATE_KEY, provider)
  : demoWallets(DEMO_MNEMONIC, provider).owner;
// Same reason as deploy.mjs: do not trust a load-balanced RPC's nonce view.
const keeper = new NonceManager(wallet);

function pickDeploymentFile() {
  if (DEPLOYMENT_FILE) return DEPLOYMENT_FILE;
  const candidates = [
    path.join(root, "contracts/deployments.latest.json"),
    path.join(root, "web/deployments", `${chainId}.json`)
  ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`No deployment found (${candidates.join(", ")})`);
  return found;
}
const file = pickDeploymentFile();
const record = JSON.parse(fs.readFileSync(file, "utf8"));
// deploy.mjs writes flat contract names; deploy-demo.mjs writes the browser's shape;
// deploy-perpl.mjs is flat too, with a factory and no mock venue.
const system = record.vaults
  ? {
      venue: record.addresses.venue,
      guard: record.addresses.guard,
      factory: record.addresses.factory,
      vaults: record.vaults.map((v) => ({ address: v.address, name: v.name }))
    }
  : {
      venue: record.DeterministicMockVenue,
      guard: record.MandateRiskGuard,
      factory: record.MandateFactory,
      vaults: [{ address: record.MandateVault ?? record.vault, name: "MandateVault" }]
    };
if (!watchOnly && !system.venue) throw new Error("Deployment has no mock venue: run with KEEPER_PRICE=0");

const venue = watchOnly
  ? null
  : new Contract(system.venue, loadAbi("mocks/DeterministicMockVenue.sol", "DeterministicMockVenue"), keeper);
const guard = new Contract(system.guard, loadAbi("MandateRiskGuard.sol", "MandateRiskGuard"), keeper);
const vaultAbi = loadAbi("MandateVault.sol", "MandateVault");
const known = new Set();
const vaults = [];
function addVault(address, name) {
  if (known.has(address.toLowerCase())) return;
  known.add(address.toLowerCase());
  vaults.push({ address, name, contract: new Contract(address, vaultAbi, provider) });
}
for (const v of system.vaults) addVault(v.address, v.name);
// Watch-only also picks up whatever the factory has made, re-read every tick so a
// vault created after the keeper started is covered.
const factory = watchOnly && system.factory
  ? new Contract(system.factory, loadAbi("MandateFactory.sol", "MandateFactory"), provider)
  : null;
async function discover() {
  if (!factory) return;
  for (const address of await factoryVaults(factory)) addVault(address, `vault ${address.slice(0, 8)}`);
}
await discover();

const intervalMs = Number(KEEPER_INTERVAL_SECONDS) * 1000;
const driftBps = BigInt(KEEPER_DRIFT_BPS);
const bandBps = BigInt(KEEPER_BAND_BPS);
const anchorE18 = venue ? await venue.priceE18() : 0n;
const floorE18 = (anchorE18 * (10_000n - bandBps)) / 10_000n;
const ceilE18 = (anchorE18 * (10_000n + bandBps)) / 10_000n;

console.log(
  `keeper ${wallet.address} on chain ${chainId} (${path.relative(root, file)}, ${vaults.length} vault(s)): ` +
    (watchOnly
      ? `watch-only${factory ? `, factory ${system.factory}` : ""}`
      : `price ${formatUnits(anchorE18, 18)} +/-${driftBps}bps every ${KEEPER_INTERVAL_SECONDS}s, ` +
        `band ${formatUnits(floorE18, 18)}..${formatUnits(ceilE18, 18)}, poke ${KEEPER_POKE === "1" ? "on" : "off"}`)
);

function nextPrice(current) {
  const step = BigInt(Math.floor(Math.random() * (2 * Number(driftBps) + 1))) - driftBps;
  let next = (current * (10_000n + step)) / 10_000n;
  if (next < floorE18) next = floorE18;
  if (next > ceilE18) next = ceilE18;
  return next;
}

// The mock-venue keeper pokes every Active vault each tick, which keeps the
// high-water mark current; without poke, observe() keeps the volatility estimate
// fed. A watch-only keeper pays gas only for a breach, an unobservable mark or an
// unwind step.
const mode = watchOnly ? "check" : KEEPER_POKE === "1" ? "mark" : "observe";

async function tick() {
  const lines = [];
  if (venue) {
    const next = nextPrice(await venue.priceE18());
    const receipt = await (await venue.setPrice(next)).wait();
    lines.push(`block ${receipt.blockNumber}: price ${formatUnits(next, 18)}`);
  } else {
    await discover();
  }
  lines.push(describeActions(await keeperTick({ guard, vaults, signer: keeper, mode, unwind: watchOnly })));
  console.log(lines.join(" | "));
}

function onTickError(error) {
  console.error("tick failed:", error.shortMessage ?? error.message);
  // A dropped or replaced transaction leaves the local nonce ahead of the chain.
  if (error.code === "NONCE_EXPIRED" || /nonce/i.test(error.message ?? "")) keeper.reset();
}

await tick();
if (!KEEPER_ONCE) {
  // A slow tick on a rate-limited RPC must not overlap the next one: two ticks
  // would both pass the same staticCalls and send the same transaction twice.
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    tick().catch(onTickError).finally(() => { busy = false; });
  }, intervalMs);
}
