// The four demo mandates and the one routine that deploys them.
//
// web/chain.mjs runs this against the in-process EDR node; contracts/script/
// deploy-demo.mjs runs the same routine against a live RPC. One definition, so
// the testnet book and the local book are the same book.
import { AbiCoder, ZeroHash, parseUnits } from "ethers";

export const coder = AbiCoder.defaultAbiCoder();
export const E18 = (n) => parseUnits(String(n), 18);
export const USDC = (n) => parseUnits(String(n), 6);

export const START_PRICE = E18(2000);
// The venue's second market. Only Momentum Vector's terms allow it.
export const START_BTC_PRICE = E18(60_000);
export const MARKETS = [
  { id: 0, symbol: "ETH" },
  { id: 1, symbol: "BTC" }
];

// Direction codes in TradeTerms: 0 either way, 1 long only, 2 short only.
export const DIRECTIONS = ["long or short", "long only", "short only"];

// Four vaults, one venue, one adapter. They differ only in the mandate their
// allocators signed - that is the entire point of the screen.
//
// Every number below binds at some point. Notional caps sit at the size of the
// vault at launch times its leverage, so as allocations grow the absolute cap,
// not the leverage ratio, is what stops the agent. Trade terms and fees are
// part of the locked terms hash like the loss terms.
export const MANDATES = [
  {
    key: "steady",
    name: "Steady Basis",
    initials: "SB",
    thesis: "Low-leverage basis carry",
    deposit: USDC(12_000),
    openSizeE18: E18(3),
    limits: {
      maxLeverageX100: 150, maxDrawdownBps: 800, maxMarkAgeSeconds: 60,
      volWindowSeconds: 300, stressHorizonSeconds: 300, stressSigmasX10: 30,
      minBlocksBetweenTrades: 0,
      maxOrderNotional: E18(10_000), maxPositionNotional: E18(18_000),
      maxTotalNotional: E18(18_000), maxBlockNotional: E18(10_000)
    },
    trade: { allowedMarkets: 0b01, direction: 0, maxPriceDeviationBps: 50, maxTradesPerDay: 24, maxDailyLossBps: 400, maxHoldingSeconds: 0 },
    fees: { performanceFeeBps: 1000, managementFeeBps: 100 }
  },
  {
    key: "range",
    name: "Range Carry",
    initials: "RC",
    thesis: "Mean-reversion inside a band",
    deposit: USDC(8_000),
    openSizeE18: E18(6),
    limits: {
      maxLeverageX100: 300, maxDrawdownBps: 1200, maxMarkAgeSeconds: 30,
      volWindowSeconds: 120, stressHorizonSeconds: 120, stressSigmasX10: 30,
      minBlocksBetweenTrades: 0,
      maxOrderNotional: E18(12_000), maxPositionNotional: E18(24_000),
      maxTotalNotional: E18(24_000), maxBlockNotional: E18(12_000)
    },
    trade: { allowedMarkets: 0b01, direction: 0, maxPriceDeviationBps: 100, maxTradesPerDay: 48, maxDailyLossBps: 600, maxHoldingSeconds: 6 * 3600 },
    fees: { performanceFeeBps: 1500, managementFeeBps: 150 }
  },
  {
    key: "momentum",
    name: "Momentum Vector",
    initials: "MV",
    thesis: "Levered trend following, ETH and BTC",
    deposit: USDC(5_000),
    openSizeE18: E18(10),
    limits: {
      maxLeverageX100: 500, maxDrawdownBps: 2000, maxMarkAgeSeconds: 30,
      // Two markets: the volatility estimate reads one price series, so the
      // guard refuses a stress term here. Daily loss stands in for it.
      volWindowSeconds: 0, stressHorizonSeconds: 0, stressSigmasX10: 0,
      minBlocksBetweenTrades: 0,
      maxOrderNotional: E18(20_000), maxPositionNotional: E18(25_000),
      maxTotalNotional: E18(30_000), maxBlockNotional: E18(20_000)
    },
    trade: { allowedMarkets: 0b11, direction: 0, maxPriceDeviationBps: 150, maxTradesPerDay: 96, maxDailyLossBps: 1000, maxHoldingSeconds: 0 },
    fees: { performanceFeeBps: 2000, managementFeeBps: 200 }
  },
  {
    key: "tight",
    name: "Tight Mandate",
    initials: "TM",
    thesis: "3% drawdown, 4s mark age",
    deposit: USDC(6_000),
    openSizeE18: E18(6),
    limits: {
      maxLeverageX100: 300, maxDrawdownBps: 300, maxMarkAgeSeconds: 4,
      volWindowSeconds: 60, stressHorizonSeconds: 60, stressSigmasX10: 30,
      minBlocksBetweenTrades: 0,
      maxOrderNotional: E18(12_000), maxPositionNotional: E18(15_000),
      maxTotalNotional: E18(15_000), maxBlockNotional: E18(12_000)
    },
    trade: { allowedMarkets: 0b01, direction: 1, maxPriceDeviationBps: 30, maxTradesPerDay: 8, maxDailyLossBps: 200, maxHoldingSeconds: 0 },
    fees: { performanceFeeBps: 1000, managementFeeBps: 50 }
  }
];
// volWindowSeconds, stressHorizonSeconds and stressSigmasX10 are the volatility
// clause (roadmap item 10): a realised volatility estimate over
// `volWindowSeconds` of marks, and any order that adds exposure must survive a
// `stressSigmasX10/10`-sigma move over `stressHorizonSeconds` without breaching
// maxDrawdownBps. Zero window = no clause.

// Defaults for a mandate that leaves a notional cap out. Every demo mandate
// sets its own; live-recover.mjs still merges these the same way.
export const NOTIONAL_LIMITS = {
  minBlocksBetweenTrades: 0,
  maxOrderNotional: E18(25_000),
  maxPositionNotional: E18(40_000),
  maxTotalNotional: E18(40_000),
  maxBlockNotional: E18(25_000)
};

// A live chain's oracle is a transaction per mark, paid for in gas, so it runs
// every few seconds rather than every block. Tight Mandate's 4s mark age cannot
// be served at that cadence; 10s still makes it the tightest book by a margin.
// Everything else is identical to the local demo.
export const PROFILES = {
  local: {},
  live: {
    tight: { thesis: "3% drawdown, 10s mark age", limits: { maxMarkAgeSeconds: 10 } }
  }
};

export function mandatesFor(profile = "local") {
  const overrides = PROFILES[profile];
  if (!overrides) throw new Error(`unknown mandate profile: ${profile}`);
  return MANDATES.map((mandate) => {
    const override = overrides[mandate.key] ?? {};
    return {
      ...mandate,
      ...override,
      limits: { ...mandate.limits, ...(override.limits ?? {}) },
      trade: { ...mandate.trade, ...(override.trade ?? {}) },
      fees: { ...mandate.fees, ...(override.fees ?? {}) }
    };
  });
}

// JSON has no BigInt, and the notional caps are 1e18-scaled. Ship them as decimal
// strings so the browser can BigInt() them back without losing precision.
export function serialiseLimits(limits) {
  return Object.fromEntries(
    Object.entries(limits).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])
  );
}

export const CONTRACT_SOURCES = {
  usdc: ["mocks/MockUSDC", "MockUSDC"],
  guard: ["MandateRiskGuard", "MandateRiskGuard"],
  venue: ["mocks/DeterministicMockVenue", "DeterministicMockVenue"],
  adapter: ["MockVenueAdapter", "MockVenueAdapter"],
  vault: ["MandateVault", "MandateVault"],
  batch: ["BatchAllocator", "BatchAllocator"],
  registry: ["MandateRegistry", "MandateRegistry"],
  factory: ["MandateFactory", "MandateFactory"]
};

// The price a demo order may name: inside the mandate's price-deviation term
// (half of it), or 5% when the mandate sets none.
export function limitPriceFor(priceE18, sizeDeltaE18, maxPriceDeviationBps) {
  const bps = BigInt(maxPriceDeviationBps ? Math.floor(maxPriceDeviationBps / 2) : 500);
  return sizeDeltaE18 > 0n ? (priceE18 * (10_000n + bps)) / 10_000n : (priceE18 * (10_000n - bps)) / 10_000n;
}

// Short enough that a live demo sees an epoch end and settle inside one
// session; the privileged settleEpoch() call still only nets signed intents,
// it never picks who gets how many shares (BatchAllocator.sol _allocate()).
export const BATCH_EPOCH_SECONDS = 20;
export const BATCH_SETTLEMENT_WINDOW_SECONDS = 600;

// DP release tuning for the demo. "epoch" here is just a strictly-increasing
// release counter, not a wall-clock window like BatchAllocator's -- the spec
// only requires epoch/pinnedBlock to advance, and giving the Reporter its own
// clock (mandate-technical-spec-v0.2.md 4.3: cadence is server config) avoids
// coupling two independent concepts to the same timer.
export const REPORT_CLIP_BOUND = 0.1; // 10% per-step return
export const REPORT_EPSILON = 0.5; // epsilon spent per release's performance stats
export const REPORT_EPSILON_CAP = 50_000_000n; // 50.0 cumulative epsilon, generous for a demo session

// Deploys USDC, guard, venue, adapter and the four vaults, locks each vault's
// terms, seeds it from the allocator and lets its agent open the position its
// mandate allows. Then deploys the BatchAllocator (every vault allowed) and the
// MandateRegistry (every vault registered), so the local book and the testnet
// book carry the same six screens. Returns the deployment record the browser
// boots from.
//
// `deploy(source, name, args)` and `abiOf(source, name)` are supplied by the
// caller because the in-process chain compiles in memory while the live script
// reads contracts/artifacts-local. `allocator`, `agents[i]` and `keeper` are
// signers; `provider` is only read for the block number and chain id.
export async function deployDemoSystem({
  deploy,
  abiOf,
  provider,
  owner,
  allocator,
  agents,
  keeper,
  basePriceE18 = START_PRICE,
  profile = "local",
  allocatorBuffer = USDC(20_000),
  batchEpochSeconds = BATCH_EPOCH_SECONDS,
  batchWindowSeconds = BATCH_SETTLEMENT_WINDOW_SECONDS,
  log = () => {}
}) {
  const mandates = mandatesFor(profile);
  if (agents.length < mandates.length) throw new Error(`need ${mandates.length} agent signers`);

  // The vaults' own allocation and opening trades are the first entries the
  // execution feed shows, so the browser needs to know where to start reading.
  const startBlock = await provider.getBlockNumber();
  const usdc = await deploy(...CONTRACT_SOURCES.usdc);
  const guard = await deploy(...CONTRACT_SOURCES.guard);
  const venue = await deploy(...CONTRACT_SOURCES.venue, [basePriceE18]);
  const venueAddress = await venue.getAddress();
  const adapter = await deploy(...CONTRACT_SOURCES.adapter, [venueAddress]);
  const adapterAddress = await adapter.getAddress();
  const usdcAddress = await usdc.getAddress();
  const guardAddress = await guard.getAddress();
  await (await venue.setAdapter(adapterAddress, true)).wait();
  log("venue, adapter, guard and USDC deployed");

  const allocatorAddress = await allocator.getAddress();
  const totalDeposits = mandates.reduce((sum, m) => sum + m.deposit, 0n);
  await (await usdc.mint(allocatorAddress, totalDeposits + allocatorBuffer)).wait();

  const vaults = [];
  for (const [index, mandate] of mandates.entries()) {
    const agentAddress = await agents[index].getAddress();
    const vault = await deploy(...CONTRACT_SOURCES.vault, [usdcAddress, guardAddress, agentAddress, adapterAddress]);
    const vaultAddress = await vault.getAddress();

    await (await guard.setAdapter(vaultAddress, adapterAddress, true)).wait();
    await (await guard.configureTerms(vaultAddress, { ...NOTIONAL_LIMITS, ...mandate.limits }, mandate.trade, mandate.fees)).wait();
    // Terms are final before the first deposit; the vault would refuse it otherwise.
    await (await guard.lockTerms(vaultAddress)).wait();

    // Seed the vault, then let its agent open the position its mandate allows.
    await (await usdc.connect(allocator).approve(vaultAddress, mandate.deposit)).wait();
    await (await vault.connect(allocator).allocate(mandate.deposit, allocatorAddress)).wait();
    // Deploying and configuring burns blocks, and every block burns chain time.
    // Re-stamp the mark first or a tight maxMarkAgeSeconds rejects the opening
    // trade - which is the guard working, just not what we want at seed time.
    await (await venue.setPrice(basePriceE18)).wait();
    const limitPrice = limitPriceFor(basePriceE18, mandate.openSizeE18, mandate.trade.maxPriceDeviationBps);
    const order = coder.encode(["int256", "uint256"], [mandate.openSizeE18, limitPrice]);
    // A block mined between the estimate and the send (the local chain's beat
    // keeps mining through a redeploy) can move the volatility sample into a
    // new slot and cost a storage write the estimate did not see. A margin
    // keeps that from reverting the seed for want of gas.
    const seedGas = await vault.connect(agents[index]).execute.estimateGas(adapterAddress, order);
    await (await vault.connect(agents[index]).execute(adapterAddress, order, { gasLimit: (seedGas * 13n) / 10n })).wait();
    log(`${mandate.name} ${vaultAddress} seeded, agent ${agentAddress}`);

    vaults.push({
      ...mandate,
      address: vaultAddress,
      agent: agentAddress,
      termsHash: await guard.termsHash(vaultAddress),
      deposit: mandate.deposit.toString(),
      openSizeE18: mandate.openSizeE18.toString(),
      limits: serialiseLimits({ ...NOTIONAL_LIMITS, ...mandate.limits })
    });
  }

  // The batcher is `owner`: settleEpoch() only nets already-verified signed
  // intents, so there is nothing a batcher key can steal by also being the
  // deployer.
  const ownerAddress = await owner.getAddress();
  const batch = await deploy(...CONTRACT_SOURCES.batch, [usdcAddress, ownerAddress, batchEpochSeconds, batchWindowSeconds]);
  const batchAddress = await batch.getAddress();
  for (const v of vaults) await (await batch.setVaultAllowed(v.address, true)).wait();
  const batchGenesis = Number(await batch.genesis());
  log(`batch allocator ${batchAddress} allows ${vaults.length} vaults`);

  // MandateRegistry: `owner` is both the admin and the configured reporter,
  // the same centralisation tradeoff as the batcher above. `owner` is also
  // `guard`'s Ownable owner, which is who registerAgent() requires as the
  // caller. registerAgent() reads the real guard off the vault and checks the
  // claimed limits against its termsHash, so this can only publish the truth.
  // v.limits is the exact merged-and-locked RiskLimits: keccak256(abi.encode())
  // depends on the numeric value, not on whether a field is a bigint or the
  // decimal string it was serialised to.
  const registry = await deploy(...CONTRACT_SOURCES.registry);
  const registryAddress = await registry.getAddress();
  await (await registry.setReporter(ownerAddress)).wait();
  await (await registry.setEpsilonCap(REPORT_EPSILON_CAP)).wait();
  for (const v of vaults) {
    await (await registry.registerAgent(v.address, adapterAddress, v.limits, v.fees, ZeroHash)).wait();
  }
  log(`registry ${registryAddress} lists ${vaults.length} agents`);

  // Everything above keeps the owner's nonce layout live-recover.mjs reads a
  // book by; what follows comes after the registry so that layout still holds.
  //
  // The factory opens registration to anyone: it deploys a vault, sets and
  // locks the terms and registers it in one transaction, inside the ranges the
  // guard enforces. From here the registry only takes vaults on this guard.
  const factory = await deploy(...CONTRACT_SOURCES.factory, [usdcAddress, guardAddress, registryAddress]);
  const factoryAddress = await factory.getAddress();
  await (await guard.setFactory(factoryAddress)).wait();
  await (await registry.setCanonicalGuard(guardAddress)).wait();
  await (await registry.setFactory(factoryAddress)).wait();
  await (await factory.listAdapter(adapterAddress, true)).wait();
  // The second market, marked straight away so a BTC order is not refused for
  // a stale price before the oracle's first round.
  await (await venue.addMarket("BTC", START_BTC_PRICE)).wait();
  log(`factory ${factoryAddress} lists the adapter; venue quotes ${MARKETS.map((m) => m.symbol).join(", ")}`);

  return {
    chainId: Number((await provider.getNetwork()).chainId),
    profile,
    addresses: { usdc: usdcAddress, guard: guardAddress, venue: venueAddress, adapter: adapterAddress, factory: factoryAddress },
    markets: MARKETS,
    accounts: {
      owner: ownerAddress,
      allocator: allocatorAddress,
      keeper: await keeper.getAddress()
    },
    abis: {
      vault: abiOf(...CONTRACT_SOURCES.vault),
      guard: abiOf(...CONTRACT_SOURCES.guard),
      adapter: abiOf(...CONTRACT_SOURCES.adapter),
      venue: abiOf(...CONTRACT_SOURCES.venue),
      usdc: abiOf(...CONTRACT_SOURCES.usdc),
      batch: abiOf(...CONTRACT_SOURCES.batch),
      registry: abiOf(...CONTRACT_SOURCES.registry),
      factory: abiOf(...CONTRACT_SOURCES.factory)
    },
    batch: {
      address: batchAddress,
      genesis: batchGenesis,
      epochDuration: Number(batchEpochSeconds),
      settlementWindow: Number(batchWindowSeconds)
    },
    registry: { address: registryAddress, clipBound: REPORT_CLIP_BOUND, epsilon: REPORT_EPSILON },
    vaults,
    startBlock,
    startedAt: Date.now()
  };
}
