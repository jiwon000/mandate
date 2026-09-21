import assert from "node:assert/strict";
import test from "node:test";
import ganache from "ganache";
import { BrowserProvider, ContractFactory, parseUnits, AbiCoder } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";

const compiled = compileContracts();

function getArtifact(source, name) {
  return artifact(compiled, source, name);
}

async function deploy(signer, source, name, args = []) {
  const { abi, bytecode } = getArtifact(source, name);
  const contract = await new ContractFactory(abi, bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

test("allocation, adapter execution, RiskGuard revert, and withdrawal", async () => {
  const chain = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337 } });
  const provider = new BrowserProvider(chain);
  const owner = await provider.getSigner(0);
  const allocator = await provider.getSigner(1);
  const agent = await provider.getSigner(2);

  const usdc = await deploy(owner, "contracts/src/mocks/MockUSDC.sol", "MockUSDC");
  const guard = await deploy(owner, "contracts/src/MandateRiskGuard.sol", "MandateRiskGuard");
  const venue = await deploy(
    owner,
    "contracts/src/mocks/DeterministicMockVenue.sol",
    "DeterministicMockVenue",
    [parseUnits("2000", 18)]
  );
  const adapter = await deploy(
    owner,
    "contracts/src/MockVenueAdapter.sol",
    "MockVenueAdapter",
    [await venue.getAddress()]
  );
  const vault = await deploy(
    owner,
    "contracts/src/MandateVault.sol",
    "MandateVault",
    [await usdc.getAddress(), await guard.getAddress(), await agent.getAddress()]
  );

  const vaultAddress = await vault.getAddress();
  const adapterAddress = await adapter.getAddress();
  await (await venue.setAdapter(adapterAddress, true)).wait();
  await (await guard.setAdapter(vaultAddress, adapterAddress, true)).wait();
  await (await guard.configure(vaultAddress, {
    maxLeverageX100: 100,
    maxRealizedDrawdownBps: 2_000,
    maxSlippageBps: 100,
    minBlocksBetweenTrades: 0,
    maxConsecutiveRejects: 3,
    maxOrderNotional: parseUnits("500", 18),
    maxPositionNotional: parseUnits("800", 18),
    maxTotalNotional: parseUnits("800", 18),
    maxBlockNotional: parseUnits("500", 18)
  })).wait();

  const deposit = parseUnits("1000", 6);
  await (await usdc.mint(await allocator.getAddress(), deposit)).wait();
  await (await usdc.connect(allocator).approve(vaultAddress, deposit)).wait();
  await (await vault.connect(allocator).allocate(deposit, await allocator.getAddress())).wait();
  assert.equal(await vault.totalAssets(), deposit);
  assert.equal(await vault.balanceOf(await allocator.getAddress()), deposit);

  const coder = AbiCoder.defaultAbiCoder();
  const validOrder = coder.encode(
    ["int256", "uint256"],
    [parseUnits("0.1", 18), parseUnits("2100", 18)]
  );
  await (await vault.connect(agent).execute(adapterAddress, validOrder)).wait();
  assert.equal(await venue.positionSizeE18(vaultAddress), parseUnits("0.1", 18));

  const overLimitOrder = coder.encode(
    ["int256", "uint256"],
    [parseUnits("1", 18), parseUnits("2100", 18)]
  );
  await assert.rejects(vault.connect(agent).execute(adapterAddress, overLimitOrder));
  assert.equal(
    await venue.positionSizeE18(vaultAddress),
    parseUnits("0.1", 18),
    "reverted order must not mutate venue position"
  );

  await (await vault.connect(allocator).withdraw(deposit, await allocator.getAddress())).wait();
  assert.equal(await usdc.balanceOf(await allocator.getAddress()), deposit);
  assert.equal(await vault.totalSupply(), 0n);
});
