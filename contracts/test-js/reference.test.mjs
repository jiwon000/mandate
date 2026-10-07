import assert from "node:assert/strict";
import test from "node:test";
import hre from "hardhat";
import { BrowserProvider, ContractFactory, ZeroHash, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";
import { BASE_LIMITS, DEFAULT_TRADE, NO_FEES, coder, termsHashOf } from "./fixture.mjs";

// The reference-price bound: the guard compares Perpl's mark with Perpl's oracle
// price and refuses new exposure while they disagree or the oracle is stale.
// PerplAdapter against MockPerplExchange, where both prices can be set apart.

const compiled = compileContracts();
const e18 = (x) => parseUnits(String(x), 18);
const usd = (x) => parseUnits(String(x), 6);
const BTC = 16;
const BTC_PNS = 600_000n; // $60,000.0, priceDecimals 1, lotDecimals 5
const REFERENCE = { maxMarkDeviationBps: 100, maxReferenceAgeSeconds: 30 };

function revertsWith(contract, name) {
  const selector = contract.interface.getError(name).selector;
  return (error) => error?.revert?.name === name || String(error?.message).includes(selector);
}

async function setup(t, { reference = REFERENCE, lock = true, trade = {} } = {}) {
  const chain = await hre.network.create();
  t.after(() => chain.close());
  const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const [owner, allocator, agent, keeper] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const deploy = async (source, name, args = []) => {
    const { abi, bytecode } = artifact(compiled, `contracts/src/${source}.sol`, name);
    const c = await new ContractFactory(abi, bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const wait = async (p) => (await p).wait();

  const usdc = await deploy("mocks/MockUSDC", "MockUSDC");
  const exchange = await deploy("mocks/MockPerplExchange", "MockPerplExchange", [usdc.target]);
  await wait(exchange.listPerp(BTC, 1, 5, BTC_PNS));
  const guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
  const adapter = await deploy("perpl/PerplAdapter", "PerplAdapter", [exchange.target, usdc.target, 500, 300, [BTC]]);
  const vault = await deploy("MandateVault", "MandateVault", [usdc.target, guard.target, agent.address, adapter.target]);
  await wait(guard.setAdapter(vault.target, adapter.target, true));
  await wait(guard.configureTerms(vault.target, BASE_LIMITS, { ...DEFAULT_TRADE, ...trade }, NO_FEES));
  // The oracle has answered once, as on Perpl; a market it never priced cannot carry the term.
  await wait(exchange.setOracle(BTC, BTC_PNS, (await provider.getBlock("latest")).timestamp));
  if (reference) await wait(guard.setReferenceTerms(vault.target, reference));
  if (lock) {
    await wait(guard.lockTerms(vault.target));
    await wait(usdc.mint(allocator.address, usd(1_000)));
    await wait(usdc.connect(allocator).approve(vault.target, usd(1_000)));
    await wait(vault.connect(allocator).allocate(usd(1_000), allocator.address));
  }

  /// Stamp the mark and the oracle; `oracleAge` backdates the oracle's timestamp.
  async function prices(mark = BTC_PNS, oracle = BTC_PNS, oracleAge = 0) {
    const { timestamp } = await provider.getBlock("latest");
    await wait(exchange.setMark(BTC, mark, timestamp));
    await wait(exchange.setOracle(BTC, oracle, timestamp - oracleAge));
  }
  const order = (size, limit) => coder.encode(["uint256", "int256", "uint256"], [0, e18(size), e18(limit)]);
  const execute = (size, limit) => vault.connect(agent).execute(adapter.target, order(size, limit));
  const lots = async () => {
    const [p] = await exchange.getPositionV2(BTC, await adapter.accountIdOf(vault.target));
    return p.lotLNS;
  };
  const side = async () => {
    const [p] = await exchange.getPositionV2(BTC, await adapter.accountIdOf(vault.target));
    return { lots: p.lotLNS, type: p.positionType };
  };
  return { provider, owner, allocator, agent, keeper, usdc, exchange, guard, adapter, vault, deploy, wait, prices, execute, lots, side };
}

test("new exposure is refused while Perpl's mark sits too far from its oracle; a reduction still passes", async (t) => {
  const s = await setup(t);
  await s.prices();
  await s.wait(s.execute("0.005", "60600"));
  assert.equal(await s.lots(), 500n);

  // The oracle 2% under the mark: about 204 bps apart against a 100 bps bound.
  await s.prices(BTC_PNS, BTC_PNS * 98n / 100n);
  const [mark, ref, , deviationBps] = await s.guard.referenceQuote(s.vault.target);
  assert.equal(mark, e18(60_000));
  assert.equal(ref, e18(58_800));
  assert.equal(deviationBps, 204n);
  await assert.rejects(s.execute("0.001", "60600"), revertsWith(s.guard, "MarkDeviationExceeded"));
  assert.equal(await s.lots(), 500n);
  await s.wait(s.execute("-0.005", "59400"));
  assert.equal(await s.lots(), 0n);

  // Back within the bound (about 50 bps apart), the same order passes. 1% under the
  // mark would not: the distance is measured in bps of the reference, 101 bps.
  await s.prices(BTC_PNS, BTC_PNS * 995n / 1000n);
  await s.wait(s.execute("0.001", "60600"));
  assert.equal(await s.lots(), 100n);
});

test("a stale oracle refuses new exposure but not a reduction", async (t) => {
  const s = await setup(t);
  await s.prices();
  await s.wait(s.execute("0.005", "60600"));
  await s.prices(BTC_PNS, BTC_PNS, 120);
  await assert.rejects(s.execute("0.001", "60600"), revertsWith(s.guard, "ReferenceTooOld"));
  await s.wait(s.execute("-0.005", "59400"));
  assert.equal(await s.lots(), 0n);
});

test("a vault without reference terms trades whatever the oracle says, with its termsHash unchanged", async (t) => {
  const s = await setup(t, { reference: null });
  assert.equal(await s.guard.termsHash(s.vault.target), termsHashOf(BASE_LIMITS));
  await s.prices(BTC_PNS, BTC_PNS / 2n, 3_600);
  await s.wait(s.execute("0.005", "60600"));
  assert.equal(await s.lots(), 500n);
});

test("reference terms are range-checked, need an adapter that can quote them, and lock with the rest", async (t) => {
  const s = await setup(t, { reference: null, lock: false });
  for (const bad of [
    { maxMarkDeviationBps: 0, maxReferenceAgeSeconds: 5 },
    { maxMarkDeviationBps: 10_001, maxReferenceAgeSeconds: 30 },
    { maxMarkDeviationBps: 100, maxReferenceAgeSeconds: 0 },
    { maxMarkDeviationBps: 100, maxReferenceAgeSeconds: 61 }
  ]) {
    await assert.rejects(s.guard.setReferenceTerms(s.vault.target, bad), revertsWith(s.guard, "InvalidReferenceTerms"));
  }
  // An adapter whose venue cannot be read cannot quote a reference price.
  await s.wait(s.exchange.setBroken(true));
  await assert.rejects(s.guard.setReferenceTerms(s.vault.target, REFERENCE), revertsWith(s.guard, "NoReferencePrice"));
  await s.wait(s.exchange.setBroken(false));
  // Nor can a market whose oracle has never answered: locking the term in would
  // refuse every order that adds exposure, for good.
  await s.wait(s.exchange.setOracle(BTC, 0, 0));
  await assert.rejects(s.guard.setReferenceTerms(s.vault.target, REFERENCE), revertsWith(s.guard, "NoReferencePrice"));
  await s.wait(s.exchange.setOracle(BTC, BTC_PNS, (await s.provider.getBlock("latest")).timestamp));

  const before = await s.guard.termsHash(s.vault.target);
  await s.wait(s.guard.setReferenceTerms(s.vault.target, REFERENCE));
  const after = await s.guard.termsHash(s.vault.target);
  assert.notEqual(after, before);
  const terms = await s.guard.referenceTermsOf(s.vault.target);
  assert.equal(terms.maxMarkDeviationBps, 100n);
  assert.equal(terms.maxReferenceAgeSeconds, 30n);

  // Cleared with all zero, the hash returns to the one without the term.
  await s.wait(s.guard.setReferenceTerms(s.vault.target, { maxMarkDeviationBps: 0, maxReferenceAgeSeconds: 0 }));
  assert.equal(await s.guard.termsHash(s.vault.target), before);

  await s.wait(s.guard.setReferenceTerms(s.vault.target, REFERENCE));
  await s.wait(s.guard.lockTerms(s.vault.target));
  await assert.rejects(s.guard.setReferenceTerms(s.vault.target, { maxMarkDeviationBps: 0, maxReferenceAgeSeconds: 0 }),
    revertsWith(s.guard, "LimitsLocked"));
});

test("the factory sets reference terms before the lock, and refuses them on an adapter with no reference price", async (t) => {
  const s = await setup(t, { reference: null, lock: false });
  const registry = await s.deploy("MandateRegistry", "MandateRegistry");
  const factory = await s.deploy("MandateFactory", "MandateFactory", [s.usdc.target, s.guard.target, registry.target]);
  await s.wait(s.guard.setFactory(factory.target));
  await s.wait(registry.setCanonicalGuard(s.guard.target));
  await s.wait(registry.setFactory(factory.target));
  await s.wait(factory.listAdapter(s.adapter.target, true));
  const params = (adapter) => ({
    agent: s.agent.address, adapter, limits: BASE_LIMITS, trade: DEFAULT_TRADE, fees: NO_FEES,
    modelHash: keccak256(toUtf8Bytes("reference test"))
  });

  const receipt = await s.wait(factory.createMandateWithReference(params(s.adapter.target), REFERENCE));
  const event = receipt.logs.map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "MandateCreated");
  const vault = event.args.vault;
  assert.equal(await s.guard.termsLocked(vault), true);
  assert.equal(event.args.termsHash, await s.guard.termsHash(vault));
  assert.notEqual(event.args.termsHash, termsHashOf(BASE_LIMITS));
  assert.equal((await s.guard.referenceTermsOf(vault)).maxMarkDeviationBps, 100n);

  // The plain call leaves the term off.
  const plain = await s.wait(factory.createMandate(params(s.adapter.target)));
  const plainVault = plain.logs.map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "MandateCreated").args.vault;
  assert.equal(await s.guard.termsHash(plainVault), termsHashOf(BASE_LIMITS));

  // A listed adapter with no reference price (the mock venue's) cannot carry the term.
  const venue = await s.deploy("mocks/DeterministicMockVenue", "DeterministicMockVenue", [e18(2_000)]);
  const mockAdapter = await s.deploy("MockVenueAdapter", "MockVenueAdapter", [venue.target]);
  await s.wait(factory.listAdapter(mockAdapter.target, true));
  await assert.rejects(factory.createMandateWithReference(params(mockAdapter.target), REFERENCE),
    revertsWith(s.guard, "NoReferencePrice"));
});

test("crossing through flat opens a new position, so it is checked like any other added exposure", async (t) => {
  const s = await setup(t, { trade: { maxTradesPerDay: 2 } });
  await s.prices();
  await s.wait(s.execute("0.005", "60600"));

  // With the mark 204 bps off the oracle, a flip from long 0.005 to short 0.005 leaves
  // total notional where it was, but the short is opened at the suspect mark.
  await s.prices(BTC_PNS, BTC_PNS * 98n / 100n);
  await assert.rejects(s.execute("-0.010", "59400"), revertsWith(s.guard, "MarkDeviationExceeded"));
  // A smaller flip shrinks the total and is refused for the same reason.
  await assert.rejects(s.execute("-0.009", "59400"), revertsWith(s.guard, "MarkDeviationExceeded"));
  assert.deepEqual(await s.side(), { lots: 500n, type: 0n });

  // Prices agree again: the flip passes and counts as the day's second trade, so a
  // third order that adds exposure is refused while closing is not.
  await s.prices();
  await s.wait(s.execute("-0.010", "59400"));
  assert.deepEqual(await s.side(), { lots: 500n, type: 1n });
  assert.equal((await s.guard.tradesOf(s.vault.target)).count, 2n);
  await s.prices();
  await assert.rejects(s.execute("0.010", "60600"), revertsWith(s.guard, "DailyTradesExceeded"));
  await s.wait(s.execute("0.005", "60600"));
  assert.equal(await s.lots(), 0n);
});

test("the guard owner can register a vault with reference terms in the registry", async (t) => {
  const s = await setup(t);
  const registry = await s.deploy("MandateRegistry", "MandateRegistry");
  await s.wait(registry.registerAgent(s.vault.target, s.adapter.target, BASE_LIMITS, NO_FEES, ZeroHash));
  const entry = await registry.agentOf(s.vault.target);
  assert.notEqual(entry.registeredAt, 0n);
  assert.equal(entry.termsHash, await s.guard.termsHash(s.vault.target));
});

test("a Closed vault pays out its cash even after the venue stops answering", async (t) => {
  const s = await setup(t, { reference: null, trade: { maxHoldingSeconds: 5 } });
  await s.prices();
  await s.wait(s.execute("0.005", "60600"));
  await s.provider.send("evm_increaseTime", [10]);
  await s.provider.send("evm_mine", []);
  await s.prices();
  await s.wait(s.guard.connect(s.keeper).poke(s.vault.target, s.adapter.target));
  for (let i = 0; i < 6 && (await s.vault.state()) === 1n; i++) {
    await s.prices();
    await s.wait(s.vault.connect(s.keeper).unwind());
  }
  assert.equal(await s.vault.state(), 2n);

  await s.wait(s.exchange.setBroken(true));
  const cash = await s.usdc.balanceOf(s.vault.target);
  const shares = await s.vault.balanceOf(s.allocator.address);
  await s.wait(s.vault.connect(s.allocator).withdraw(shares, s.allocator.address));
  assert.equal(await s.vault.balanceOf(s.allocator.address), 0n);
  assert.ok(cash - (await s.usdc.balanceOf(s.vault.target)) > usd(990));
});

test("a price move past the position cap still lets the agent shrink the position in pieces", async (t) => {
  const s = await setup(t, { reference: null });
  await s.prices();
  // 0.03 BTC at $60,000 is $1,800, inside the $2,000 position cap.
  await s.wait(s.execute("0.03", "60600"));
  // At $70,000 the same position is $2,100: over the cap without any trade.
  await s.prices(700_000n, 700_000n);
  // Selling a thousandth leaves $2,030, still over the cap, and passes because it shrinks.
  await s.wait(s.execute("-0.001", "69300"));
  assert.equal(await s.lots(), 2_900n);
  // Buying it back adds exposure, so the cap binds it.
  await assert.rejects(s.execute("0.001", "70700"), revertsWith(s.guard, "PositionNotionalExceeded"));
});
