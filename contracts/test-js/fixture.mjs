import hre from "hardhat";
import { BrowserProvider, ContractFactory, parseUnits, AbiCoder, keccak256 } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";

// Compiled once for every suite that imports this module, instead of once per file.
const compiled = compileContracts();
export const coder = AbiCoder.defaultAbiCoder();

export const BASE_LIMITS = {
  maxLeverageX100: 300,
  maxDrawdownBps: 200,
  maxMarkAgeSeconds: 60,
  minBlocksBetweenTrades: 0,
  maxOrderNotional: parseUnits("2000", 18),
  maxPositionNotional: parseUnits("2000", 18),
  maxTotalNotional: parseUnits("2000", 18),
  maxBlockNotional: parseUnits("2000", 18),
  // Stress terms off by default so every test that is not about them sees the
  // guard exactly as before. stress.test.mjs turns them on per test.
  volWindowSeconds: 0,
  stressHorizonSeconds: 0,
  stressSigmasX10: 0
};

/// The guard's terms when only configure(limits) is called: market 0, both
/// directions, no other trade term, no fees.
export const DEFAULT_TRADE = {
  allowedMarkets: 1, direction: 0, maxPriceDeviationBps: 0,
  maxTradesPerDay: 0, maxDailyLossBps: 0, maxHoldingSeconds: 0
};
export const NO_FEES = { performanceFeeBps: 0, managementFeeBps: 0 };

const LIMITS_TUPLE = "tuple(uint16,uint16,uint32,uint32,uint256,uint256,uint256,uint256,uint32,uint32,uint16)";
const TRADE_TUPLE = "tuple(uint32,uint8,uint16,uint16,uint16,uint32)";
const FEES_TUPLE = "tuple(uint16,uint16)";

/// keccak256(abi.encode(limits, tradeTerms, fees)), what MandateRiskGuard.termsHash returns.
export function termsHashOf(l, t = DEFAULT_TRADE, fee = NO_FEES) {
  return keccak256(coder.encode([LIMITS_TUPLE, TRADE_TUPLE, FEES_TUPLE], [
    [
      l.maxLeverageX100, l.maxDrawdownBps, l.minBlocksBetweenTrades, l.maxMarkAgeSeconds,
      l.maxOrderNotional, l.maxPositionNotional, l.maxTotalNotional, l.maxBlockNotional,
      l.volWindowSeconds, l.stressHorizonSeconds, l.stressSigmasX10
    ],
    [t.allowedMarkets, t.direction, t.maxPriceDeviationBps, t.maxTradesPerDay, t.maxDailyLossBps, t.maxHoldingSeconds],
    [fee.performanceFeeBps, fee.managementFeeBps]
  ]));
}

/// One vault funded with 1,000 mUSDC, one venue at $2,000, one agent, one keeper,
/// and a 0.5 ETH order that lands exactly on 1.00x leverage.
export async function fixture(t, limitOverrides = {}, { lockTerms = true, trade, fees } = {}) {
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
  if (trade || fees) {
    await (await guard.configureTerms(
      vaultAddress, { ...BASE_LIMITS, ...limitOverrides }, { ...DEFAULT_TRADE, ...trade }, { ...NO_FEES, ...fees }
    )).wait();
  } else {
    await (await guard.configure(vaultAddress, { ...BASE_LIMITS, ...limitOverrides })).wait();
  }

  // Deposits need final terms, so the seed deposit comes after the lock. A test that
  // wants to watch the lock itself, or change the terms first, opts out of both and
  // locks and funds on its own.
  const deposit = parseUnits("1000", 6);
  if (lockTerms) {
    await (await guard.lockTerms(vaultAddress)).wait();
    await (await usdc.mint(await allocator.getAddress(), deposit)).wait();
    await (await usdc.connect(allocator).approve(vaultAddress, deposit)).wait();
    await (await vault.connect(allocator).allocate(deposit, await allocator.getAddress())).wait();
  }

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
