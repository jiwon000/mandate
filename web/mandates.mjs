// The four demo mandates and the one routine that deploys them.
//
// web/chain.mjs runs this against the in-process EDR node; contracts/script/
// deploy-demo.mjs runs the same routine against a live RPC. One definition, so
// the testnet book and the local book are the same book.
import { AbiCoder, parseUnits } from "ethers";

export const coder = AbiCoder.defaultAbiCoder();
export const E18 = (n) => parseUnits(String(n), 18);
export const USDC = (n) => parseUnits(String(n), 6);

export const START_PRICE = E18(2000);

// Four vaults, one venue, one adapter. They differ only in the mandate their
// allocators signed - that is the entire point of the screen.
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
      volWindowSeconds: 300, stressHorizonSeconds: 300, stressSigmasX10: 30
    }
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
      volWindowSeconds: 120, stressHorizonSeconds: 120, stressSigmasX10: 30
    }
  },
  {
    key: "momentum",
    name: "Momentum Vector",
    initials: "MV",
    thesis: "Levered trend following",
    deposit: USDC(5_000),
    openSizeE18: E18(10),
    limits: {
      maxLeverageX100: 500, maxDrawdownBps: 2000, maxMarkAgeSeconds: 30,
      volWindowSeconds: 60, stressHorizonSeconds: 60, stressSigmasX10: 20
    }
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
      volWindowSeconds: 60, stressHorizonSeconds: 60, stressSigmasX10: 30
    }
  }
];
// The last three terms are the volatility clause (roadmap item 10): a realised
// volatility estimate over `volWindowSeconds` of marks, and any order that adds
// exposure must survive a `stressSigmasX10/10`-sigma move over
// `stressHorizonSeconds` without breaching maxDrawdownBps. Zero window = no clause.

// Generous notional caps across the board so leverage and drawdown are what
// actually bind. A cap that never binds teaches nobody anything.
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
    return { ...mandate, ...override, limits: { ...mandate.limits, ...(override.limits ?? {}) } };
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
  vault: ["MandateVault", "MandateVault"]
};

// Deploys USDC, guard, venue, adapter and the four vaults, locks each vault's
// terms, seeds it from the allocator and lets its agent open the position its
// mandate allows. Returns the deployment record the browser boots from.
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
    await (await guard.configure(vaultAddress, { ...NOTIONAL_LIMITS, ...mandate.limits })).wait();
    // Terms are final before the first deposit; the vault would refuse it otherwise.
    await (await guard.lockTerms(vaultAddress)).wait();

    // Seed the vault, then let its agent open the position its mandate allows.
    await (await usdc.connect(allocator).approve(vaultAddress, mandate.deposit)).wait();
    await (await vault.connect(allocator).allocate(mandate.deposit, allocatorAddress)).wait();
    // Deploying and configuring burns blocks, and every block burns chain time.
    // Re-stamp the mark first or a tight maxMarkAgeSeconds rejects the opening
    // trade - which is the guard working, just not what we want at seed time.
    await (await venue.setPrice(basePriceE18)).wait();
    const order = coder.encode(["int256", "uint256"], [mandate.openSizeE18, basePriceE18 * 2n]);
    await (await vault.connect(agents[index]).execute(adapterAddress, order)).wait();
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

  return {
    chainId: Number((await provider.getNetwork()).chainId),
    profile,
    addresses: { usdc: usdcAddress, guard: guardAddress, venue: venueAddress, adapter: adapterAddress },
    accounts: {
      owner: await owner.getAddress(),
      allocator: allocatorAddress,
      keeper: await keeper.getAddress()
    },
    abis: {
      vault: abiOf(...CONTRACT_SOURCES.vault),
      guard: abiOf(...CONTRACT_SOURCES.guard),
      adapter: abiOf(...CONTRACT_SOURCES.adapter),
      venue: abiOf(...CONTRACT_SOURCES.venue),
      usdc: abiOf(...CONTRACT_SOURCES.usdc)
    },
    vaults,
    startBlock,
    startedAt: Date.now()
  };
}
