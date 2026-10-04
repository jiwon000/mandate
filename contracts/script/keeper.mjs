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
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, NonceManager, Wallet, formatUnits } from "ethers";
import { loadAbi } from "./artifacts.mjs";
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
  KEEPER_ONCE = ""
} = process.env;
if (!MONAD_RPC_URL || !(DEPLOYER_PRIVATE_KEY || DEMO_MNEMONIC)) {
  throw new Error("Set MONAD_RPC_URL and DEPLOYER_PRIVATE_KEY or DEMO_MNEMONIC");
}

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
// deploy.mjs writes flat contract names; deploy-demo.mjs writes the browser's shape.
const system = record.vaults
  ? {
      venue: record.addresses.venue,
      guard: record.addresses.guard,
      adapter: record.addresses.adapter,
      vaults: record.vaults.map((v) => ({ address: v.address, name: v.name }))
    }
  : {
      venue: record.DeterministicMockVenue,
      guard: record.MandateRiskGuard,
      adapter: record.MockVenueAdapter,
      vaults: [{ address: record.MandateVault, name: "MandateVault" }]
    };

const venue = new Contract(system.venue, loadAbi("mocks/DeterministicMockVenue.sol", "DeterministicMockVenue"), keeper);
const guard = new Contract(system.guard, loadAbi("MandateRiskGuard.sol", "MandateRiskGuard"), keeper);
const vaultAbi = loadAbi("MandateVault.sol", "MandateVault");
const vaults = system.vaults.map((v) => ({ ...v, contract: new Contract(v.address, vaultAbi, provider) }));

const intervalMs = Number(KEEPER_INTERVAL_SECONDS) * 1000;
const driftBps = BigInt(KEEPER_DRIFT_BPS);
const bandBps = BigInt(KEEPER_BAND_BPS);
const anchorE18 = await venue.priceE18();
const floorE18 = (anchorE18 * (10_000n - bandBps)) / 10_000n;
const ceilE18 = (anchorE18 * (10_000n + bandBps)) / 10_000n;

console.log(
  `keeper ${wallet.address} on chain ${chainId} (${path.relative(root, file)}, ${vaults.length} vault(s)): ` +
    `price ${formatUnits(anchorE18, 18)} +/-${driftBps}bps every ${KEEPER_INTERVAL_SECONDS}s, ` +
    `band ${formatUnits(floorE18, 18)}..${formatUnits(ceilE18, 18)}, poke ${KEEPER_POKE === "1" ? "on" : "off"}`
);

function nextPrice(current) {
  const step = BigInt(Math.floor(Math.random() * (2 * Number(driftBps) + 1))) - driftBps;
  let next = (current * (10_000n + step)) / 10_000n;
  if (next < floorE18) next = floorE18;
  if (next > ceilE18) next = ceilE18;
  return next;
}

async function serve(vault) {
  if (KEEPER_POKE === "1") {
    // poke() reverts once a vault is Frozen or Closed; try it before paying for it.
    const state = await vault.contract.state();
    if (state !== 0n) return `${vault.name}: state ${state}, no poke`;
    try {
      await guard.poke.staticCall(vault.address, system.adapter);
      const poked = await (await guard.poke(vault.address, system.adapter)).wait();
      const breach = poked.logs.some((log) => {
        try { return guard.interface.parseLog(log)?.name === "DrawdownBreach"; } catch { return false; }
      });
      return `${vault.name}: ${breach ? "poke FROZE the vault, bounty paid" : "poke marked"}`;
    } catch (error) {
      return `${vault.name}: poke skipped (${error.shortMessage ?? error.message})`;
    }
  }
  // No poke means nothing else feeds the mark to the volatility estimate, and
  // an estimate built from stale samples over-states the risk of every order.
  // observe() is the side-effect-free way to keep it current.
  try {
    await (await guard.observe(vault.address, system.adapter)).wait();
    return `${vault.name}: observed`;
  } catch (error) {
    return `${vault.name}: observe skipped (${error.shortMessage ?? error.message})`;
  }
}

async function tick() {
  const next = nextPrice(await venue.priceE18());
  const receipt = await (await venue.setPrice(next)).wait();
  const lines = [`block ${receipt.blockNumber}: price ${formatUnits(next, 18)}`];
  for (const vault of vaults) lines.push(await serve(vault));
  console.log(lines.join(" | "));
}

function onTickError(error) {
  console.error("tick failed:", error.shortMessage ?? error.message);
  // A dropped or replaced transaction leaves the local nonce ahead of the chain.
  if (error.code === "NONCE_EXPIRED" || /nonce/i.test(error.message ?? "")) keeper.reset();
}

await tick();
if (!KEEPER_ONCE) {
  setInterval(() => tick().catch(onTickError), intervalMs);
}
