import fs from "node:fs";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseUnits } from "ethers";
import { loadArtifact } from "./artifacts.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function deploy(signer, relativePath, name, args = []) {
  const artifact = loadArtifact(relativePath, name);
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  console.log(`${name}: ${await contract.getAddress()}`);
  return contract;
}

const {
  MONAD_RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  AGENT_ADDRESS,
  BATCH_EPOCH_SECONDS = "3600",
  BATCH_SETTLEMENT_WINDOW_SECONDS = "1800"
} = process.env;
if (!MONAD_RPC_URL || !DEPLOYER_PRIVATE_KEY || !AGENT_ADDRESS) {
  throw new Error("Set MONAD_RPC_URL, DEPLOYER_PRIVATE_KEY, and AGENT_ADDRESS");
}

const provider = new JsonRpcProvider(MONAD_RPC_URL);
const wallet = new Wallet(DEPLOYER_PRIVATE_KEY, provider);
// Track nonces locally. A public RPC behind a load balancer can answer
// eth_getTransactionCount from a node that has not seen the previous transaction
// yet, and this script sends a dozen back to back.
const deployer = new NonceManager(wallet);
const network = await provider.getNetwork();
console.log(`Deploying from ${wallet.address} to chain ${network.chainId}`);

const usdc = await deploy(deployer, "mocks/MockUSDC.sol", "MockUSDC");
const guard = await deploy(deployer, "MandateRiskGuard.sol", "MandateRiskGuard");
const venue = await deploy(
  deployer,
  "mocks/DeterministicMockVenue.sol",
  "DeterministicMockVenue",
  [parseUnits("2000", 18)]
);
const adapter = await deploy(
  deployer,
  "MockVenueAdapter.sol",
  "MockVenueAdapter",
  [await venue.getAddress()]
);
const vault = await deploy(
  deployer,
  "MandateVault.sol",
  "MandateVault",
  [await usdc.getAddress(), await guard.getAddress(), AGENT_ADDRESS, await adapter.getAddress()]
);

// The batcher is the deployer for now: settleEpoch() is the one privileged call on
// the batch path, and escrow withdrawal never depends on it.
const batch = await deploy(
  deployer,
  "BatchAllocator.sol",
  "BatchAllocator",
  [await usdc.getAddress(), wallet.address, BATCH_EPOCH_SECONDS, BATCH_SETTLEMENT_WINDOW_SECONDS]
);

const vaultAddress = await vault.getAddress();
const adapterAddress = await adapter.getAddress();
await (await venue.setAdapter(adapterAddress, true)).wait();
await (await guard.setAdapter(vaultAddress, adapterAddress, true)).wait();
await (await batch.setVaultAllowed(vaultAddress, true)).wait();
// maxMarkAgeSeconds is only honoured if something keeps the venue's mark fresh.
// DeterministicMockVenue.updatedAt moves on setPrice() alone, so run
// `npm run keeper:monad` against this deployment or every allocate/withdraw/
// execute/poke reverts with MarkTooOld thirty seconds after the last push.
await (await guard.configure(vaultAddress, {
  maxLeverageX100: 300,
  maxDrawdownBps: 200,
  maxMarkAgeSeconds: 30,
  minBlocksBetweenTrades: 0,
  maxOrderNotional: parseUnits("500", 18),
  maxPositionNotional: parseUnits("1500", 18),
  maxTotalNotional: parseUnits("1500", 18),
  maxBlockNotional: parseUnits("750", 18),
  // Stress test: a 3-sigma move over the next 60 seconds on the post-trade exposure
  // must stay inside maxDrawdownBps. Volatility is estimated over a 5-minute window
  // from the marks the guard observes; see README "Risk enforcement".
  volWindowSeconds: 300,
  stressHorizonSeconds: 60,
  stressSigmasX10: 30
})).wait();
// Deposits are refused until the terms are locked, and after the lock neither the
// limits nor the adapter allowlist can change. Different terms mean a new vault.
await (await guard.lockTerms(vaultAddress)).wait();
const termsHash = await guard.termsHash(vaultAddress);

const addresses = {
  chainId: network.chainId.toString(),
  deployer: wallet.address,
  MockUSDC: await usdc.getAddress(),
  MandateRiskGuard: await guard.getAddress(),
  DeterministicMockVenue: await venue.getAddress(),
  MockVenueAdapter: adapterAddress,
  MandateVault: vaultAddress,
  BatchAllocator: await batch.getAddress(),
  termsHash
};
fs.writeFileSync(
  path.join(root, "contracts/deployments.latest.json"),
  `${JSON.stringify(addresses, null, 2)}\n`
);
