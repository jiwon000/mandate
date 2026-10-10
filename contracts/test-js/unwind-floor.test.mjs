import assert from "node:assert/strict";
import test from "node:test";
import hre from "hardhat";
import { BrowserProvider, ContractFactory, ZeroHash, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { artifact } from "../tools/compiler.mjs";
import { BASE_LIMITS, DEFAULT_TRADE, NO_FEES, coder, fixture, termsHashOf, termsHashWithFloorOf } from "./fixture.mjs";
import { BTC, BTC_PNS, compiled, setup as perplSetup } from "./perpl-fixture.mjs";

// The unwind bounty floor: a mandate can promise each unwind() step a flat amount
// on top of the 0.01% share, so a step on a small vault still covers its gas. The
// vault pays max(share, floor), never past 0.2% of its cash, and only for closing
// size. The floor is a locked term and part of termsHash; a vault without one
// hashes and pays exactly as before.

const NO_REFERENCE = { maxMarkDeviationBps: 0, maxReferenceAgeSeconds: 0 };
const HALF = parseUnits("0.5", 6);
const FIVE = parseUnits("5", 6);

function revertsWith(contract, name) {
  const selector = contract.interface.getError(name).selector;
  return (error) => error?.revert?.name === name || String(error?.message).includes(selector);
}

function eventsNamed(receipt, contract, name) {
  return receipt.logs
    .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .filter((l) => l?.name === name);
}

/// The unwind fixture with a floor set before the lock: 0.5 ETH bought at $2000,
/// marked at $1800, frozen by poke() on the 10% drawdown with 999.5 mUSDC of cash.
async function frozenWithFloor(t, floor, { trade } = {}) {
  const f = await fixture(t, {}, { lockTerms: false, trade });
  await (await f.guard.setUnwindBountyFloor(f.vaultAddress, floor)).wait();
  await (await f.guard.lockTerms(f.vaultAddress)).wait();
  const allocator = await f.fund(f.allocator, f.deposit);
  await (await f.vault.connect(f.allocator).allocate(f.deposit, allocator)).wait();
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 1n, "Frozen");
  assert.equal(await f.vault.totalAssets(), parseUnits("999.5", 6));
  return f;
}

async function step(f) {
  const keeper = await f.keeper.getAddress();
  const before = await f.usdc.balanceOf(keeper);
  const cash = await f.vault.totalAssets();
  const receipt = await (await f.vault.connect(f.keeper).unwind()).wait();
  const [unwound] = eventsNamed(receipt, f.vault, "Unwound");
  assert.equal((await f.usdc.balanceOf(keeper)) - before, unwound.args.bounty, "the event states what was paid");
  return { bounty: unwound.args.bounty, closedNotional: unwound.args.closedNotional, cash };
}

test("a vault without a floor hashes and pays exactly as before", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.guard.unwindBountyFloorOf(f.vaultAddress), 0n);
  assert.equal(await f.guard.termsHash(f.vaultAddress), termsHashOf(BASE_LIMITS));
  assert.equal(await f.vault.UNWIND_BOUNTY_BPS(), 1n);
  assert.equal(await f.vault.UNWIND_BOUNTY_CAP_BPS(), 20n);

  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  const first = await step(f);
  assert.equal(first.bounty, 99_950n, "0.01% of 999.5 mUSDC, the share alone");
  const second = await step(f);
  assert.equal(second.bounty, 99_940n, "0.01% of 999.40005 mUSDC");
});

test("a floor above the share is paid in full on a vault that can carry it", async (t) => {
  const f = await frozenWithFloor(t, HALF);
  assert.equal(await f.guard.unwindBountyFloorOf(f.vaultAddress), HALF);
  // 0.01% of 999.5 is 0.09995; the floor is 0.5 and the cap 1.999, so the floor pays.
  const first = await step(f);
  assert.equal(first.bounty, HALF);
  assert.equal(await f.vault.totalAssets(), parseUnits("999", 6));
  const second = await step(f);
  assert.equal(second.bounty, HALF, "the same flat amount on the next step");
  assert.equal(await f.vault.state(), 1n, "still Frozen with 0.3 ETH open");
});

test("the cap, not the floor, binds on a vault too small for its floor", async (t) => {
  const f = await frozenWithFloor(t, FIVE);
  const start = await f.vault.totalAssets();
  let paid = 0n;
  for (let i = 0; i < 5; i++) {
    const { bounty, cash } = await step(f);
    assert.equal(bounty, (cash * 20n) / 10_000n, `step ${i + 1} pays 0.2% of the cash it found`);
    assert.ok(bounty < FIVE);
    paid += bounty;
  }
  assert.equal(await f.vault.state(), 2n, "Closed after five steps");
  // 0.2% a step compounds to just under 1% of the cash at freeze for the whole close.
  assert.ok(paid <= start / 100n, `five steps cost ${paid} of ${start}`);
  assert.ok(paid > (start * 99n) / 10_000n);
});

test("a step pays from idle cash only, so a vault with none pays nothing and still closes size", async (t) => {
  // Frozen by holding time with the position in profit, so the allocator's claim
  // exceeds the cash and withdraw() pays the cash out whole.
  const f = await frozenWithFloorInProfit(t, HALF);
  const allocator = await f.allocator.getAddress();
  await (await f.vault.connect(f.allocator).withdraw(await f.vault.balanceOf(allocator), allocator)).wait();
  assert.equal(await f.vault.totalAssets(), 0n, "every unit of cash left with the allocator");
  assert.ok((await f.vault.balanceOf(allocator)) > 0n, "the position's share of the claim stays as shares");

  const { bounty, closedNotional } = await step(f);
  assert.ok(closedNotional > 0n, "the step still closed a fifth of the position");
  assert.equal(bounty, 0n, "a floor cannot pay what the vault does not hold");
  assert.equal(await f.vault.unwindStepsDone(), 1n);
});

/// Frozen on the holding-time term with the mark up at $2200: equity above cash.
async function frozenWithFloorInProfit(t, floor) {
  const f = await fixture(t, {}, { lockTerms: false, trade: { maxHoldingSeconds: 5 } });
  await (await f.guard.setUnwindBountyFloor(f.vaultAddress, floor)).wait();
  await (await f.guard.lockTerms(f.vaultAddress)).wait();
  const allocator = await f.fund(f.allocator, f.deposit);
  await (await f.vault.connect(f.allocator).allocate(f.deposit, allocator)).wait();
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await f.chain.provider.request({ method: "evm_increaseTime", params: [10] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
  await (await f.venue.setPrice(parseUnits("2200", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 1n, "Frozen on holding time");
  return f;
}

test("on Perpl the cap is measured on the cash in the vault, not on the margin at the venue", async (t) => {
  const s = await perplSetup(t, { floor: FIVE, trade: { maxHoldingSeconds: 5 } });
  await s.trade(0, "0.005", "60600"); // $300 of BTC: about $66 of margin leaves for Perpl
  await s.freeze();
  await s.fresh();
  const [equity] = await s.adapter.markEquity(s.vault.target);
  const before = await s.usdc.balanceOf(s.keeper.address);
  await s.wait(s.vault.connect(s.keeper).unwind());
  const bounty = (await s.usdc.balanceOf(s.keeper.address)) - before;
  // The step first closes a fifth and releases its margin to the vault, then pays
  // out of the cash the vault holds at that moment; the rest of the margin is still at Perpl.
  const cashAtPayment = (await s.usdc.balanceOf(s.vault.target)) + bounty;
  assert.ok(cashAtPayment < equity, "part of the equity sits at Perpl");
  assert.equal(bounty, (cashAtPayment * 20n) / 10_000n, "0.2% of the cash, under the $5 floor");
  assert.ok(bounty < (equity * 20n) / 10_000n);
});

test("a step that finds the book flat pays nothing, floor or not", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  await (await f.guard.setUnwindBountyFloor(f.vaultAddress, HALF)).wait();
  await (await f.guard.lockTerms(f.vaultAddress)).wait();
  const allocator = await f.fund(f.allocator, f.deposit);
  await (await f.vault.connect(f.allocator).allocate(f.deposit, allocator)).wait();
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  // The agent closes at $1800 itself: flat, but 10% under the high-water mark.
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  const close = coder.encode(["int256", "uint256"], [parseUnits("-0.5", 18), parseUnits("1700", 18)]);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, close)).wait();
  assert.equal(await f.vault.state(), 1n);
  const { bounty, closedNotional } = await step(f);
  assert.equal(closedNotional, 0n);
  assert.equal(bounty, 0n);
  assert.equal(await f.vault.state(), 2n, "Closed");
});

test("the floor is a term: owner or factory only, configured first, immutable after the lock", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  await assert.rejects(f.guard.setUnwindBountyFloor(await f.outsider.getAddress(), HALF),
    revertsWith(f.guard, "LimitsNotConfigured"));
  await assert.rejects(f.guard.connect(f.outsider).setUnwindBountyFloor(f.vaultAddress, HALF),
    revertsWith(f.guard, "OnlyOwnerOrFactory"));

  const receipt = await (await f.guard.setUnwindBountyFloor(f.vaultAddress, HALF)).wait();
  const [set] = eventsNamed(receipt, f.guard, "UnwindBountyFloorSet");
  assert.equal(set.args.vault, f.vaultAddress);
  assert.equal(set.args.floor, HALF);
  assert.equal(await f.guard.unwindBountyFloorOf(f.vaultAddress), HALF);

  await (await f.guard.lockTerms(f.vaultAddress)).wait();
  await assert.rejects(f.guard.setUnwindBountyFloor(f.vaultAddress, FIVE), revertsWith(f.guard, "LimitsLocked"));
  await assert.rejects(f.guard.setUnwindBountyFloor(f.vaultAddress, 0n), revertsWith(f.guard, "LimitsLocked"));
  assert.equal(await f.guard.unwindBountyFloorOf(f.vaultAddress), HALF);
});

test("termsHash is unchanged at floor zero and moves with any other floor", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  const plain = termsHashOf(BASE_LIMITS);
  assert.equal(await f.guard.termsHash(f.vaultAddress), plain);

  await (await f.guard.setUnwindBountyFloor(f.vaultAddress, HALF)).wait();
  const withHalf = await f.guard.termsHash(f.vaultAddress);
  assert.notEqual(withHalf, plain);
  assert.equal(withHalf, termsHashWithFloorOf(BASE_LIMITS, DEFAULT_TRADE, NO_FEES, NO_REFERENCE, HALF));

  await (await f.guard.setUnwindBountyFloor(f.vaultAddress, 1n)).wait();
  const withOne = await f.guard.termsHash(f.vaultAddress);
  assert.notEqual(withOne, withHalf);
  assert.notEqual(withOne, plain);

  // Clearing it restores the hash of a vault that never had one.
  await (await f.guard.setUnwindBountyFloor(f.vaultAddress, 0n)).wait();
  assert.equal(await f.guard.termsHash(f.vaultAddress), plain);

  await (await f.guard.setUnwindBountyFloor(f.vaultAddress, HALF)).wait();
  const receipt = await (await f.guard.lockTerms(f.vaultAddress)).wait();
  const [locked] = eventsNamed(receipt, f.guard, "TermsLocked");
  assert.equal(locked.args.termsHash, withHalf, "the lock quotes the hash with the floor in it");
});

test("the factory sets the floor before the lock; the older entry points leave it off", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  const factory = await f.deploy("MandateFactory", "MandateFactory", [
    await f.usdc.getAddress(), await f.guard.getAddress(), await registry.getAddress()
  ]);
  await (await f.guard.setFactory(await factory.getAddress())).wait();
  await (await registry.setCanonicalGuard(await f.guard.getAddress())).wait();
  await (await registry.setFactory(await factory.getAddress())).wait();
  await (await factory.listAdapter(f.adapterAddress, true)).wait();
  const params = {
    agent: await f.agent.getAddress(), adapter: f.adapterAddress, limits: BASE_LIMITS, trade: DEFAULT_TRADE,
    fees: NO_FEES, modelHash: keccak256(toUtf8Bytes("floor test"))
  };
  const createdVault = (receipt) => eventsNamed(receipt, factory, "MandateCreated")[0].args;

  const withFloor = createdVault(await (await factory.createMandateWithFloor(params, NO_REFERENCE, HALF)).wait());
  assert.equal(await f.guard.termsLocked(withFloor.vault), true);
  assert.equal(await f.guard.unwindBountyFloorOf(withFloor.vault), HALF);
  assert.equal(withFloor.termsHash, await f.guard.termsHash(withFloor.vault));
  assert.equal(withFloor.termsHash, termsHashWithFloorOf(BASE_LIMITS, DEFAULT_TRADE, NO_FEES, NO_REFERENCE, HALF));
  assert.equal((await registry.agentOf(withFloor.vault)).termsHash, withFloor.termsHash);

  const plain = createdVault(await (await factory.createMandate(params)).wait());
  assert.equal(await f.guard.unwindBountyFloorOf(plain.vault), 0n);
  assert.equal(plain.termsHash, termsHashOf(BASE_LIMITS));
  const zero = createdVault(await (await factory.createMandateWithFloor(params, NO_REFERENCE, 0n)).wait());
  assert.equal(zero.termsHash, termsHashOf(BASE_LIMITS), "a zero floor is no floor");
});

test("with reference terms the floor is appended after them, and registerAgent recomputes the same hash", async (t) => {
  // PerplAdapter against MockPerplExchange, the one adapter that can carry a
  // reference term, with both terms set by hand before the lock.
  const REFERENCE = { maxMarkDeviationBps: 100, maxReferenceAgeSeconds: 30 };
  const chain = await hre.network.create();
  t.after(() => chain.close());
  const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const [owner, agent] = await Promise.all([0, 2].map((i) => provider.getSigner(i)));
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
  await wait(guard.configureTerms(vault.target, BASE_LIMITS, DEFAULT_TRADE, NO_FEES));
  await wait(exchange.setOracle(BTC, BTC_PNS, (await provider.getBlock("latest")).timestamp));
  await wait(guard.setReferenceTerms(vault.target, REFERENCE));
  const withReference = await guard.termsHash(vault.target);

  await wait(guard.setUnwindBountyFloor(vault.target, HALF));
  const both = await guard.termsHash(vault.target);
  assert.notEqual(both, withReference);
  assert.equal(both, termsHashWithFloorOf(BASE_LIMITS, DEFAULT_TRADE, NO_FEES, REFERENCE, HALF));
  await wait(guard.lockTerms(vault.target));

  const registry = await deploy("MandateRegistry", "MandateRegistry");
  await wait(registry.registerAgent(vault.target, adapter.target, BASE_LIMITS, NO_FEES, ZeroHash));
  assert.equal((await registry.agentOf(vault.target)).termsHash, both);
  // Restating other fees is still a mismatch: the floor adds to the hash, it does not replace it.
  const other = await deploy("MandateRegistry", "MandateRegistry");
  await assert.rejects(
    other.registerAgent(vault.target, adapter.target, BASE_LIMITS, { performanceFeeBps: 100, managementFeeBps: 0 }, ZeroHash),
    revertsWith(other, "TermsMismatch")
  );
});
