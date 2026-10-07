import assert from "node:assert/strict";
import test from "node:test";
import { ZeroHash, parseUnits } from "ethers";
import { BASE_LIMITS, coder, fixture } from "./fixture.mjs";

// The three tiers of a stop. A daily loss pauses new risk until the next UTC day
// (marketplace.test.mjs). A stopped feed freezes the vault but leaves a recovery
// window: if the mark comes back and every limit holds, anyone resumes it. A
// drawdown or holding-time breach freezes for good: unwind, then Closed.

const e18 = (x) => parseUnits(String(x), 18);
const RECOVERY = 15 * 60;
const FEES = { performanceFeeBps: 0, managementFeeBps: 0 };

function revertsWith(contract, name) {
  const selector = contract.interface.getError(name).selector;
  return (error) => error?.revert?.name === name || String(error?.message).includes(selector);
}

async function advance(f, seconds) {
  await f.chain.provider.request({ method: "evm_increaseTime", params: [seconds] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
}

const order = (size, limit) => coder.encode(["int256", "uint256"], [e18(size), e18(limit)]);
const run = async (f, o) => (await f.vault.connect(f.agent).execute(f.adapterAddress, o)).wait();

/// A vault with an open position whose feed stopped long enough to be frozen.
async function unobservable(t) {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 });
  await run(f, f.order);
  await advance(f, 31);
  await (await f.guard.connect(f.keeper).freezeUnobservable(f.vaultAddress)).wait();
  assert.equal(await f.vault.state(), 1n);
  return f;
}

test("a vault frozen for a stopped feed resumes once the mark is back and every limit holds", async (t) => {
  const f = await unobservable(t);
  // Still no feed: the re-mark refuses, so the vault stays frozen.
  await assert.rejects(f.guard.connect(f.outsider).resume(f.vaultAddress), revertsWith(f.guard, "MarkTooOld"));

  await (await f.venue.setPrice(e18(1990))).wait();
  const receipt = await (await f.guard.connect(f.outsider).resume(f.vaultAddress)).wait();
  assert.ok(receipt.logs.some((log) => f.guard.interface.parseLog(log)?.name === "Resumed"));
  assert.equal(await f.vault.state(), 0n, "Active again");
  // The terms did not reset: the high-water mark is the one from before the freeze.
  const [, highWater] = await f.guard.quote(f.vaultAddress, f.adapterAddress);
  assert.ok(highWater >= e18(1), "high-water mark kept");

  // The agent trades again, and there is nothing to unwind.
  await run(f, order("-0.1", "1990"));
  await assert.rejects(f.vault.connect(f.keeper).unwind(), revertsWith(f.vault, "NotFrozen"));
  await assert.rejects(f.guard.resume(f.vaultAddress), revertsWith(f.guard, "NotResumable"));
});

test("resume() refuses when the fresh mark shows a breach, and the window then goes to unwind", async (t) => {
  const f = await unobservable(t);
  // $1,000 long at $2,000: down past the 2% drawdown cap while nobody could see it.
  await (await f.venue.setPrice(e18(1900))).wait();
  await assert.rejects(f.guard.connect(f.outsider).resume(f.vaultAddress), revertsWith(f.guard, "StillBreached"));
  assert.equal(await f.vault.state(), 1n);

  await assert.rejects(f.vault.connect(f.keeper).unwind(), revertsWith(f.vault, "UnwindNotYet"));
  await advance(f, RECOVERY);
  await (await f.venue.setPrice(e18(1900))).wait();
  await (await f.vault.connect(f.keeper).unwind()).wait();
  // One step taken: the position is no longer the agent's, even if the feed is fine now.
  await (await f.venue.setPrice(e18(2000))).wait();
  await assert.rejects(f.guard.connect(f.outsider).resume(f.vaultAddress), revertsWith(f.vault, "UnwindStarted"));
});

test("a drawdown freeze is final: no recovery window and no resume", async (t) => {
  const f = await fixture(t);
  await run(f, f.order);
  await (await f.venue.setPrice(e18(1900))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 1n);
  assert.equal(await f.guard.unwindAllowedAt(f.vaultAddress), 0n);
  await (await f.venue.setPrice(e18(2000))).wait();
  await assert.rejects(f.guard.connect(f.outsider).resume(f.vaultAddress), revertsWith(f.guard, "NotResumable"));
  await (await f.vault.connect(f.keeper).unwind()).wait();
  await assert.rejects(f.vault.connect(f.agent).resume(), revertsWith(f.vault, "OnlyRiskGuard"));
});

test("the registry records a resume, and a later freeze over it", async (t) => {
  const f = await unobservable(t);
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  await (await registry.registerAgent(f.vaultAddress, f.adapterAddress, { ...BASE_LIMITS, maxMarkAgeSeconds: 10 }, FEES, ZeroHash)).wait();
  await (await registry.recordOutcome(f.vaultAddress)).wait();
  assert.equal((await registry.outcomeOf(f.vaultAddress)).state, 1n);

  await (await f.venue.setPrice(e18(2000))).wait();
  await (await f.guard.resume(f.vaultAddress)).wait();
  await (await registry.recordOutcome(f.vaultAddress)).wait();
  let outcome = await registry.outcomeOf(f.vaultAddress);
  assert.equal(outcome.state, 0n, "resumed");
  assert.equal(outcome.reason, 2n, "the reason it was stopped is kept");
  await assert.rejects(registry.recordOutcome(f.vaultAddress), revertsWith(registry, "NothingToRecord"));

  await (await f.venue.setPrice(e18(1900))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  await (await registry.recordOutcome(f.vaultAddress)).wait();
  outcome = await registry.outcomeOf(f.vaultAddress);
  assert.equal(outcome.state, 1n);
  assert.equal(outcome.reason, 1n, "drawdown this time");
});
