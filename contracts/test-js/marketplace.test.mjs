import assert from "node:assert/strict";
import test from "node:test";
import { ZeroHash, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { BASE_LIMITS, DEFAULT_TRADE, NO_FEES, coder, fixture, termsHashOf } from "./fixture.mjs";

// The marketplace layer: permissionless registration through MandateFactory, the
// canonical guard, trade terms beyond size and leverage, several markets on one
// venue, fees taken as shares, and the exit from a vault whose feed stopped.

const DAILY_LOSS = 3n;
const HOLDING_TIME = 4n;
const UNOBSERVABLE = 2n;
const e18 = (x) => parseUnits(String(x), 18);
const usd = (x) => parseUnits(String(x), 6);

function revertsWith(contract, name) {
  const selector = contract.interface.getError(name).selector;
  return (error) => error?.revert?.name === name || String(error?.message).includes(selector);
}

async function advance(f, seconds) {
  await f.chain.provider.request({ method: "evm_increaseTime", params: [seconds] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
}

// Market 0 orders keep the 64-byte layout; any other market uses 96 bytes.
const order0 = (size, limit) => coder.encode(["int256", "uint256"], [e18(size), e18(limit)]);
const orderOn = (market, size, limit) => coder.encode(["uint256", "int256", "uint256"], [market, e18(size), e18(limit)]);
const run = async (f, order) => (await f.vault.connect(f.agent).execute(f.adapterAddress, order)).wait();

async function marketplace(f) {
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  const factory = await f.deploy("MandateFactory", "MandateFactory", [
    await f.usdc.getAddress(), await f.guard.getAddress(), await registry.getAddress()
  ]);
  const factoryAddress = await factory.getAddress();
  await (await f.guard.setFactory(factoryAddress)).wait();
  await (await registry.setCanonicalGuard(await f.guard.getAddress())).wait();
  await (await registry.setFactory(factoryAddress)).wait();
  await (await factory.listAdapter(f.adapterAddress, true)).wait();
  return { registry, factory };
}

const params = (agent, adapter, over = {}) => ({
  agent,
  adapter,
  limits: BASE_LIMITS,
  trade: DEFAULT_TRADE,
  fees: NO_FEES,
  modelHash: keccak256(toUtf8Bytes("model v1")),
  ...over
});

async function created(f, factory, signer, p) {
  const receipt = await (await factory.connect(signer).createMandate(p)).wait();
  const event = receipt.logs.map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "MandateCreated");
  return f.vault.attach(event.args.vault);
}

test("anyone can create, lock and register a mandate through the factory in one transaction", async (t) => {
  const f = await fixture(t);
  const { registry, factory } = await marketplace(f);
  const outsider = await f.outsider.getAddress();
  const agent = await f.agent.getAddress();
  const trade = { ...DEFAULT_TRADE, direction: 1, maxTradesPerDay: 20, maxDailyLossBps: 300 };
  const fees = { performanceFeeBps: 1500, managementFeeBps: 100 };

  const vault = await created(f, factory, f.outsider, params(agent, f.adapterAddress, { trade, fees }));
  const vaultAddress = await vault.getAddress();
  assert.equal(await f.guard.termsLocked(vaultAddress), true);
  assert.equal(await f.guard.termsHash(vaultAddress), termsHashOf(BASE_LIMITS, trade, fees));
  assert.equal(await vault.agent(), agent);

  const entry = await registry.agentOf(vaultAddress);
  assert.equal(entry.termsHash, termsHashOf(BASE_LIMITS, trade, fees));
  assert.equal(entry.fees.performanceFeeBps, 1500n);
  assert.equal(await registry.operatorOf(vaultAddress), outsider);
  assert.equal(await factory.vaultCount(), 1n);
  assert.deepEqual([...(await factory.vaultsFrom(0, 10))], [vaultAddress]);
  assert.deepEqual([...(await registry.registeredVaults(0, 10))], [vaultAddress]);
  // Created by someone other than the agent, so it is not listed under the agent.
  assert.deepEqual([...(await registry.vaultsOf(agent))], []);

  // The agent creating its own mandate is listed at once.
  const own = await created(f, factory, f.agent, params(agent, f.adapterAddress));
  assert.deepEqual([...(await registry.vaultsOf(agent))], [await own.getAddress()]);

  // The new vault takes deposits and trades under the terms it was created with.
  const depositor = await f.fund(f.allocator, usd(1000));
  await (await f.usdc.connect(f.allocator).approve(vaultAddress, usd(1000))).wait();
  await (await vault.connect(f.allocator).allocate(usd(1000), depositor)).wait();
  await (await f.vault.attach(vaultAddress).connect(f.agent).execute(f.adapterAddress, order0("0.25", "2000"))).wait();
  await assert.rejects(
    vault.connect(f.agent).execute(f.adapterAddress, order0("-0.5", "1990")),
    revertsWith(f.guard, "DirectionNotAllowed")
  );
});

test("the factory refuses unlisted adapters and limits outside its range", async (t) => {
  const f = await fixture(t);
  const { factory } = await marketplace(f);
  const agent = await f.agent.getAddress();
  await assert.rejects(
    factory.createMandate(params(agent, await f.outsider.getAddress())),
    revertsWith(factory, "AdapterNotListed")
  );
  for (const bad of [
    { maxLeverageX100: 0 },
    { maxLeverageX100: 2_001 },
    { maxOrderNotional: 0 },
    { maxOrderNotional: e18(3000), maxBlockNotional: e18(2000) },
    { minBlocksBetweenTrades: 100_001 }
  ]) {
    await assert.rejects(
      factory.createMandate(params(agent, f.adapterAddress, { limits: { ...BASE_LIMITS, ...bad } })),
      revertsWith(factory, "InvalidLimits"),
      JSON.stringify(bad, (_, v) => (typeof v === "bigint" ? v.toString() : v))
    );
  }
  // The guard's own range still applies to factory-made terms.
  await assert.rejects(
    factory.createMandate(params(agent, f.adapterAddress, { limits: { ...BASE_LIMITS, maxDrawdownBps: 0 } })),
    revertsWith(f.guard, "InvalidLossTerms")
  );
  await assert.rejects(
    factory.createMandate(params(agent, f.adapterAddress, { fees: { performanceFeeBps: 3_001, managementFeeBps: 0 } })),
    revertsWith(f.guard, "InvalidFeeTerms")
  );
  await assert.rejects(
    factory.createMandate(params(agent, f.adapterAddress, { trade: { ...DEFAULT_TRADE, allowedMarkets: 0 } })),
    revertsWith(f.guard, "InvalidTradeTerms")
  );
});

test("only the owner or the named factory configures the canonical guard, and the factory is named once", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  const { factory } = await marketplace(f);
  await assert.rejects(
    f.guard.connect(f.outsider).configure(f.vaultAddress, BASE_LIMITS),
    revertsWith(f.guard, "OnlyOwnerOrFactory")
  );
  await assert.rejects(
    f.guard.connect(f.outsider).lockTerms(f.vaultAddress),
    revertsWith(f.guard, "OnlyOwnerOrFactory")
  );
  await assert.rejects(f.guard.setFactory(await f.outsider.getAddress()), revertsWith(f.guard, "FactoryAlreadySet"));
  await assert.rejects(
    factory.connect(f.outsider).listAdapter(await f.outsider.getAddress(), true),
    /OwnableUnauthorizedAccount|revert/
  );
});

test("once a canonical guard is named, a vault behind any other guard cannot be registered", async (t) => {
  const f = await fixture(t);
  const { registry } = await marketplace(f);
  // A second guard and vault, configured and locked by that guard's owner: the
  // self-deployed pair the registry used to catalog under its own address.
  const other = await f.deploy("MandateRiskGuard", "MandateRiskGuard");
  const vault = await f.deploy("MandateVault", "MandateVault", [
    await f.usdc.getAddress(), await other.getAddress(), await f.agent.getAddress(), f.adapterAddress
  ]);
  const vaultAddress = await vault.getAddress();
  await (await other.setAdapter(vaultAddress, f.adapterAddress, true)).wait();
  await (await other.configure(vaultAddress, BASE_LIMITS)).wait();
  await (await other.lockTerms(vaultAddress)).wait();
  await assert.rejects(
    registry.registerAgent(vaultAddress, f.adapterAddress, BASE_LIMITS, NO_FEES, ZeroHash),
    revertsWith(registry, "NotCanonicalGuard")
  );
  // The canonical guard's own vault still registers through the owner path.
  await (await registry.registerAgent(f.vaultAddress, f.adapterAddress, BASE_LIMITS, NO_FEES, ZeroHash)).wait();
  // Fees are in the hash: restating different fees is a mismatch.
  const f2 = await fixture(t, {}, { fees: { performanceFeeBps: 1000, managementFeeBps: 0 } });
  const registry2 = await f2.deploy("MandateRegistry", "MandateRegistry");
  await assert.rejects(
    registry2.registerAgent(f2.vaultAddress, f2.adapterAddress, BASE_LIMITS, NO_FEES, ZeroHash),
    revertsWith(registry2, "TermsMismatch")
  );
  await assert.rejects(registry.connect(f.outsider).registerFromFactory(vaultAddress, f.adapterAddress, ZeroHash, await f.outsider.getAddress()),
    revertsWith(registry, "OnlyFactory"));
});

test("a market outside the allowlist is refused; an allowed second market trades and is marked", async (t) => {
  const f = await fixture(t);
  await (await f.venue.addMarket("BTC", e18(60_000))).wait();
  await assert.rejects(run(f, orderOn(1, "0.01", "60100")), revertsWith(f.guard, "MarketNotAllowed"));

  const g = await fixture(t, {}, { trade: { allowedMarkets: 3 } });
  await (await g.venue.addMarket("BTC", e18(60_000))).wait();
  await run(g, order0("0.25", "2000"));
  await run(g, orderOn(1, "0.01", "60000"));
  assert.equal(await g.venue.positionOf(g.vaultAddress, 1), e18("0.01"));
  const [maxNotional, totalNotional] = await g.adapter.positionState(g.vaultAddress);
  assert.equal(maxNotional, e18(600));
  assert.equal(totalNotional, e18(1100));

  // Equity sums the PnL of every market; markedAt is the oldest open market's mark.
  await (await g.venue.setPrices([e18(2100), e18(57_000)])).wait();
  const [equity] = await g.adapter.markEquity(g.vaultAddress);
  // +0.25*100 on ETH, -0.01*3000 on BTC: 1000 + 25 - 30.
  assert.equal(equity, usd(995));
  await advance(g, 30);
  await (await g.venue.setMarketPrice(0, e18(2100))).wait();
  const [, markedAt] = await g.adapter.markEquity(g.vaultAddress);
  assert.equal(markedAt, await g.venue.updatedAtOf(1));
});

test("long-only refuses any order that leaves the vault short", async (t) => {
  const f = await fixture(t, {}, { trade: { direction: 1 } });
  await assert.rejects(run(f, order0("-0.25", "1990")), revertsWith(f.guard, "DirectionNotAllowed"));
  await run(f, order0("0.25", "2000"));
  await run(f, order0("-0.25", "2000"));
  await assert.rejects(run(f, order0("-0.1", "2000")), revertsWith(f.guard, "DirectionNotAllowed"));

  const s = await fixture(t, {}, { trade: { direction: 2 } });
  await assert.rejects(run(s, order0("0.25", "2000")), revertsWith(s.guard, "DirectionNotAllowed"));
  await run(s, order0("-0.25", "2000"));
});

test("a limit price too far from the mark is refused", async (t) => {
  const f = await fixture(t, {}, { trade: { maxPriceDeviationBps: 100 } });
  // 2100 against a 2000 mark is 5%.
  await assert.rejects(run(f, f.order), revertsWith(f.guard, "PriceDeviationExceeded"));
  await run(f, order0("0.5", "2020"));
});

test("the daily trade count stops new exposure but never a reduction, and resets the next UTC day", async (t) => {
  const f = await fixture(t, {}, { trade: { maxTradesPerDay: 1 } });
  await run(f, order0("0.25", "2000"));
  await assert.rejects(run(f, order0("0.25", "2000")), revertsWith(f.guard, "DailyTradesExceeded"));
  await run(f, order0("-0.1", "2000"));
  await advance(f, 86_400);
  await (await f.venue.setPrice(e18(2000))).wait();
  await run(f, order0("0.25", "2000"));
});

test("a daily loss past its bound freezes the vault even inside the drawdown cap", async (t) => {
  // Drawdown cap 2%, daily loss 1%: a 1.5% loss trips only the daily term.
  const f = await fixture(t, {}, { trade: { maxDailyLossBps: 100 } });
  await run(f, f.order);
  await (await f.venue.setPrice(e18(1970))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 1n);
  const [reason] = await f.guard.freezeOf(f.vaultAddress);
  assert.equal(reason, DAILY_LOSS);

  const control = await fixture(t);
  await run(control, control.order);
  await (await control.venue.setPrice(e18(1970))).wait();
  await (await control.guard.poke(control.vaultAddress, control.adapterAddress)).wait();
  assert.equal(await control.vault.state(), 0n, "1.5% is inside the 2% drawdown cap");
});

test("a position held past the holding limit lets anyone freeze the vault; going flat resets the clock", async (t) => {
  const f = await fixture(t, {}, { trade: { maxHoldingSeconds: 3_600 } });
  await run(f, f.order);
  assert.notEqual(await f.guard.positionOpenedAt(f.vaultAddress), 0n);
  await advance(f, 1_800);
  await (await f.venue.setPrice(e18(2000))).wait();
  await (await f.guard.poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 0n);

  await run(f, order0("-0.5", "2000"));
  assert.equal(await f.guard.positionOpenedAt(f.vaultAddress), 0n);
  await run(f, f.order);
  await advance(f, 3_601);
  await (await f.venue.setPrice(e18(2000))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 1n);
  const [reason] = await f.guard.freezeOf(f.vaultAddress);
  assert.equal(reason, HOLDING_TIME);
});

test("a management fee accrues on marked equity as agent shares, only on a fresh mark and only while Active", async (t) => {
  const f = await fixture(t, {}, { fees: { managementFeeBps: 200 } });
  const agent = await f.agent.getAddress();
  const since = await f.vault.lastFeeAccrual();
  assert.notEqual(since, 0n);

  // A year passes with no mark: nothing is charged and the clock does not move.
  await advance(f, 365 * 86_400);
  await (await f.vault.accrueFees()).wait();
  assert.equal(await f.vault.balanceOf(agent), 0n);
  assert.equal(await f.vault.lastFeeAccrual(), since);

  await (await f.venue.setPrice(e18(2000))).wait();
  await (await f.vault.accrueFees()).wait();
  const shares = await f.vault.balanceOf(agent);
  const [equity] = await f.vault.markedAssets();
  const worth = (shares * equity) / (await f.vault.totalSupply());
  // 2% of 1,000 for a year and a few seconds.
  assert.ok(worth >= usd(20) && worth < usd("20.01"), `fee worth ${worth}`);

  // The allocator is left with the rest.
  const allocator = await f.allocator.getAddress();
  const before = await f.usdc.balanceOf(allocator);
  await (await f.vault.connect(f.allocator).withdraw(await f.vault.balanceOf(allocator), allocator)).wait();
  const paid = (await f.usdc.balanceOf(allocator)) - before;
  assert.ok(paid > usd(979) && paid < usd(980), `paid ${paid}`);
});

test("a performance fee is charged only above the fee high-water mark and is not counted as drawdown", async (t) => {
  // 30% of a 10% gain is 2.7% of NAV, more than the 2% drawdown cap: without the
  // restatement in onFeeMint the fee itself would freeze the vault.
  const f = await fixture(t, {}, { fees: { performanceFeeBps: 3_000 } });
  const agent = await f.agent.getAddress();
  await run(f, f.order);
  await (await f.venue.setPrice(e18(2200))).wait();
  await (await f.guard.poke(f.vaultAddress, f.adapterAddress)).wait();
  await (await f.vault.accrueFees()).wait();
  const shares = await f.vault.balanceOf(agent);
  const [equity] = await f.vault.markedAssets();
  const supply = await f.vault.totalSupply();
  const worth = (shares * equity) / supply;
  assert.ok(worth >= usd("29.99") && worth <= usd(30), `fee worth ${worth}`);

  await (await f.guard.poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 0n, "the fee is not drawdown");

  // Back down and up to the same price: no new high, no new fee.
  await (await f.venue.setPrice(e18(2150))).wait();
  await (await f.vault.accrueFees()).wait();
  await (await f.venue.setPrice(e18(2200))).wait();
  await (await f.vault.accrueFees()).wait();
  assert.equal(await f.vault.balanceOf(agent), shares);
});

test("fees stop at the freeze", async (t) => {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 }, { fees: { managementFeeBps: 500 } });
  await advance(f, 31);
  await (await f.guard.freezeUnobservable(f.vaultAddress)).wait();
  await advance(f, 365 * 86_400);
  await (await f.venue.setPrice(e18(2000))).wait();
  const pending = await f.vault.pendingFees();
  assert.equal(pending.shares, 0n);
  await (await f.vault.accrueFees()).wait();
  assert.equal(await f.vault.balanceOf(await f.agent.getAddress()), 0n);
});

test("a vault whose feed stopped reaches exit: freeze, five unwinds, then withdrawal needs no mark", async (t) => {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 });
  await run(f, f.order);
  await advance(f, 31);
  const allocator = await f.allocator.getAddress();
  const shares = await f.vault.balanceOf(allocator);
  await assert.rejects(f.vault.connect(f.allocator).withdraw(shares, allocator), revertsWith(f.guard, "MarkTooOld"));

  await (await f.guard.connect(f.keeper).freezeUnobservable(f.vaultAddress)).wait();
  const [reason] = await f.guard.freezeOf(f.vaultAddress);
  assert.equal(reason, UNOBSERVABLE);
  for (let i = 0; i < 5; i++) await (await f.vault.connect(f.keeper).unwind()).wait();
  assert.equal(await f.vault.state(), 2n, "Closed");

  // The feed is still stopped, and the allocator leaves anyway.
  await advance(f, 600);
  const before = await f.usdc.balanceOf(allocator);
  await (await f.vault.connect(f.allocator).withdraw(shares, allocator)).wait();
  assert.ok((await f.usdc.balanceOf(allocator)) - before > usd(990));
});

test("a vault whose feed stopped pays a cash-only exit before it is unwound", async (t) => {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 });
  await run(f, f.order);
  const allocator = await f.allocator.getAddress();
  const shares = await f.vault.balanceOf(allocator);
  // Active: the cash-only exit is not for a vault that can still be priced or frozen.
  await assert.rejects(f.vault.connect(f.allocator).withdrawUnpriced(shares, allocator, 0),
    revertsWith(f.vault, "NotFrozen"));

  await advance(f, 31);
  await (await f.guard.connect(f.keeper).freezeUnobservable(f.vaultAddress)).wait();
  const supply = await f.vault.totalSupply();
  const cash = await f.usdc.balanceOf(f.vaultAddress);
  const [, , lastNav] = await f.guard.dayOf(f.vaultAddress);
  const half = shares / 2n;
  const cashSlice = (half * cash) / supply;
  const atLastMark = (half * lastNav) / 10n ** 18n;
  const expected = cashSlice < atLastMark ? cashSlice : atLastMark;

  // A floor above what it pays is refused.
  await assert.rejects(f.vault.connect(f.allocator).withdrawUnpriced(half, allocator, expected + 1n),
    revertsWith(f.vault, "BelowMinimum"));
  const before = await f.usdc.balanceOf(allocator);
  await (await f.vault.connect(f.allocator).withdrawUnpriced(half, allocator, expected)).wait();
  assert.equal((await f.usdc.balanceOf(allocator)) - before, expected);
  assert.equal(await f.vault.balanceOf(allocator), shares - half);
  // Whoever stays is never worse off per share in cash.
  const left = await f.usdc.balanceOf(f.vaultAddress);
  assert.ok(left * supply >= cash * (supply - half), "cash per remaining share did not fall");

  // Once the venue marks again the full-price withdraw() is the way out.
  await (await f.venue.setPrice(e18(2000))).wait();
  await assert.rejects(f.vault.connect(f.allocator).withdrawUnpriced(1n, allocator, 0),
    revertsWith(f.vault, "MarkIsFresh"));
});
