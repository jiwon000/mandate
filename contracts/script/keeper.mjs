// Keeps a testnet deployment alive.
//
// DeterministicMockVenue's mark is only as fresh as its last setPrice(), and the
// vault's guard refuses any mark older than maxMarkAgeSeconds (30s in deploy.mjs).
// On the demo server web/chain.mjs pushes a price every block; on a real chain
// nothing does unless this runs. Each tick nudges the price by a bounded random
// step, keeps it inside a band around the deployment's start price, and then
// pokes the guard so a drawdown breach is caught without anyone watching.
//
// Usage: MONAD_RPC_URL=... DEPLOYER_PRIVATE_KEY=... npm run keeper:monad
// The key must be the venue's owner (setPrice is onlyOwner); the deployer is.
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, NonceManager, Wallet, formatUnits } from "ethers";

const root = path.resolve(import.meta.dirname, "../..");

function loadAbi(relativePath, name) {
  const file = path.join(root, "contracts/artifacts-local", relativePath, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

const {
  MONAD_RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  KEEPER_INTERVAL_SECONDS = "10",
  KEEPER_DRIFT_BPS = "20",
  KEEPER_BAND_BPS = "1000",
  KEEPER_POKE = "1",
  KEEPER_ONCE = ""
} = process.env;
if (!MONAD_RPC_URL || !DEPLOYER_PRIVATE_KEY) {
  throw new Error("Set MONAD_RPC_URL and DEPLOYER_PRIVATE_KEY");
}

const deployment = JSON.parse(
  fs.readFileSync(path.join(root, "contracts/deployments.latest.json"), "utf8")
);
const provider = new JsonRpcProvider(MONAD_RPC_URL);
const wallet = new Wallet(DEPLOYER_PRIVATE_KEY, provider);
// Same reason as deploy.mjs: do not trust a load-balanced RPC's nonce view.
const keeper = new NonceManager(wallet);
const venue = new Contract(
  deployment.DeterministicMockVenue,
  loadAbi("mocks/DeterministicMockVenue.sol", "DeterministicMockVenue"),
  keeper
);
const guard = new Contract(
  deployment.MandateRiskGuard,
  loadAbi("MandateRiskGuard.sol", "MandateRiskGuard"),
  keeper
);
const vault = new Contract(
  deployment.MandateVault,
  loadAbi("MandateVault.sol", "MandateVault"),
  provider
);

const intervalMs = Number(KEEPER_INTERVAL_SECONDS) * 1000;
const driftBps = BigInt(KEEPER_DRIFT_BPS);
const bandBps = BigInt(KEEPER_BAND_BPS);
const anchorE18 = await venue.priceE18();
const floorE18 = (anchorE18 * (10_000n - bandBps)) / 10_000n;
const ceilE18 = (anchorE18 * (10_000n + bandBps)) / 10_000n;

console.log(
  `keeper ${wallet.address} on chain ${(await provider.getNetwork()).chainId}: ` +
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

async function tick() {
  const current = await venue.priceE18();
  const next = nextPrice(current);
  const receipt = await (await venue.setPrice(next)).wait();
  let line = `block ${receipt.blockNumber}: price ${formatUnits(next, 18)}`;

  if (KEEPER_POKE === "1") {
    // poke() reverts once a vault is Frozen or Closed; try it before paying for it.
    const state = await vault.state();
    if (state === 0n) {
      try {
        await guard.poke.staticCall(deployment.MandateVault, deployment.MockVenueAdapter);
        const poked = await (await guard.poke(deployment.MandateVault, deployment.MockVenueAdapter)).wait();
        const breach = poked.logs.some((log) => {
          try { return guard.interface.parseLog(log)?.name === "DrawdownBreach"; } catch { return false; }
        });
        line += breach ? ", poke: FROZE the vault, bounty paid" : ", poke: marked";
      } catch (error) {
        line += `, poke skipped (${error.shortMessage ?? error.message})`;
      }
    } else {
      line += `, vault state ${state} (no poke)`;
    }
  }
  console.log(line);
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
