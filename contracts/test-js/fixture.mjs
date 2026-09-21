import hre from "hardhat";
import { BrowserProvider, ContractFactory, parseUnits, AbiCoder } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";

// Compiled once for every suite that imports this module, instead of once per file.
const compiled = compileContracts();
export const coder = AbiCoder.defaultAbiCoder();

export const BASE_LIMITS = {
  maxLeverageX100: 300,
  maxDrawdownBps: 200,
  maxMarkAgeSeconds: 3_600,
  maxSlippageBps: 100,
  minBlocksBetweenTrades: 0,
  maxConsecutiveRejects: 3,
  maxOrderNotional: parseUnits("2000", 18),
  maxPositionNotional: parseUnits("2000", 18),
  maxTotalNotional: parseUnits("2000", 18),
  maxBlockNotional: parseUnits("2000", 18)
};

/// One vault funded with 1,000 mUSDC, one venue at $2,000, one agent, one keeper,
/// and a 0.5 ETH order that lands exactly on 1.00x leverage.
export async function fixture(t, limitOverrides = {}) {
  const chain = await hre.network.create();
  t.after(() => chain.close());
  const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const [owner, allocator, agent, keeper, outsider] = await Promise.all(
    [0, 1, 2, 3, 4].map((i) => provider.getSigner(i))
  );

  async function deploy(source, name, args = []) {
    const { abi, bytecode } = artifact(compiled, `contracts/src/${source}.sol`, name);
    const contract = await new ContractFactory(abi, bytecode, owner).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }

  const usdc = await deploy("mocks/MockUSDC", "MockUSDC");
  const guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
  const venue = await deploy("mocks/DeterministicMockVenue", "DeterministicMockVenue", [
    parseUnits("2000", 18)
  ]);
  const adapter = await deploy("MockVenueAdapter", "MockVenueAdapter", [await venue.getAddress()]);
  const vault = await deploy("MandateVault", "MandateVault", [
    await usdc.getAddress(),
    await guard.getAddress(),
    await agent.getAddress(),
    await adapter.getAddress()
  ]);

  const vaultAddress = await vault.getAddress();
  const adapterAddress = await adapter.getAddress();
  await (await venue.setAdapter(adapterAddress, true)).wait();
  await (await guard.setAdapter(vaultAddress, adapterAddress, true)).wait();
  await (await guard.configure(vaultAddress, { ...BASE_LIMITS, ...limitOverrides })).wait();

  const deposit = parseUnits("1000", 6);
  await (await usdc.mint(await allocator.getAddress(), deposit)).wait();
  await (await usdc.connect(allocator).approve(vaultAddress, deposit)).wait();
  await (await vault.connect(allocator).allocate(deposit, await allocator.getAddress())).wait();

  // 0.5 ETH @ $2000 = $1000 notional against $1000 equity: exactly 1.00x.
  const order = coder.encode(["int256", "uint256"], [parseUnits("0.5", 18), parseUnits("2100", 18)]);

  /// Fund `signer` with `amount` mUSDC and approve the vault to pull it.
  async function fund(signer, amount) {
    const address = await signer.getAddress();
    await (await usdc.mint(address, amount)).wait();
    await (await usdc.connect(signer).approve(vaultAddress, amount)).wait();
    return address;
  }

  return {
    chain, provider, owner, allocator, agent, keeper, outsider,
    usdc, guard, venue, adapter, vault, deploy, fund,
    vaultAddress, adapterAddress, deposit, order
  };
}
