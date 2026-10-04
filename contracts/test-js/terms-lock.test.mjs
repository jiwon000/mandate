import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, parseUnits } from "ethers";
import { BASE_LIMITS, coder, fixture } from "./fixture.mjs";

const LIMITS_TUPLE = "tuple(uint16,uint16,uint32,uint32,uint256,uint256,uint256,uint256)";
const hashOf = (l) =>
  keccak256(coder.encode([LIMITS_TUPLE], [[
    l.maxLeverageX100, l.maxDrawdownBps, l.minBlocksBetweenTrades, l.maxMarkAgeSeconds,
    l.maxOrderNotional, l.maxPositionNotional, l.maxTotalNotional, l.maxBlockNotional
  ]]));

test("a vault takes no deposit until its terms are locked", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  const allocatorAddress = await f.fund(f.allocator, parseUnits("10", 6));
  assert.equal(await f.guard.termsLocked(f.vaultAddress), false);
  await assert.rejects(
    f.vault.connect(f.allocator).allocate(parseUnits("10", 6), allocatorAddress),
    /TermsNotLocked|revert/,
    "the fixture's own seed deposit was made after the lock; this one is before it"
  );

  await (await f.guard.lockTerms(f.vaultAddress)).wait();
  await (await f.vault.connect(f.allocator).allocate(parseUnits("10", 6), allocatorAddress)).wait();
  assert.ok((await f.vault.balanceOf(allocatorAddress)) > 0n);
});

test("locked terms cannot be reconfigured, re-allowlisted or locked twice", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.guard.termsLocked(f.vaultAddress), true);
  await assert.rejects(
    f.guard.configure(f.vaultAddress, { ...BASE_LIMITS, maxDrawdownBps: 9_000 }),
    /LimitsLocked|revert/,
    "the owner cannot loosen the drawdown term after allocators funded it"
  );
  await assert.rejects(
    f.guard.setAdapter(f.vaultAddress, f.adapterAddress, false),
    /LimitsLocked|revert/,
    "nor quietly stop the agent by pulling the adapter"
  );
  await assert.rejects(f.guard.lockTerms(f.vaultAddress), /LimitsLocked|revert/);
  const stored = await f.guard.limitsOf(f.vaultAddress);
  assert.equal(stored.maxDrawdownBps, BigInt(BASE_LIMITS.maxDrawdownBps), "terms unchanged");
});

test("lockTerms is owner-only and needs configured limits", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  await assert.rejects(f.guard.connect(f.outsider).lockTerms(f.vaultAddress), /OwnableUnauthorizedAccount|revert/);
  const strangerVault = await f.outsider.getAddress();
  await assert.rejects(f.guard.lockTerms(strangerVault), /LimitsNotConfigured|revert/);
});

test("termsHash is the hash of the limits and is what the lock event quotes", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  assert.equal(await f.guard.termsHash(f.vaultAddress), hashOf(BASE_LIMITS));

  // Still open: a change to one term changes the hash the allocator would be shown.
  const tighter = { ...BASE_LIMITS, maxDrawdownBps: 100 };
  await (await f.guard.configure(f.vaultAddress, tighter)).wait();
  assert.equal(await f.guard.termsHash(f.vaultAddress), hashOf(tighter));
  assert.notEqual(hashOf(tighter), hashOf(BASE_LIMITS));

  const receipt = await (await f.guard.lockTerms(f.vaultAddress)).wait();
  const locked = receipt.logs
    .map((l) => { try { return f.guard.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "TermsLocked");
  assert.equal(locked.args.vault, f.vaultAddress);
  assert.equal(locked.args.termsHash, hashOf(tighter));
});
