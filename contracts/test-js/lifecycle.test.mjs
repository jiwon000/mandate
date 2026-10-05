import assert from "node:assert/strict";
import test from "node:test";
import { ZeroHash, parseUnits } from "ethers";
import { fixture, BASE_LIMITS } from "./fixture.mjs";

// Freeze rules and what the registry records afterwards
// (docs/mandate-lifecycle-design.md, items 1-3 of the pre-hackathon order of work).

const DRAWDOWN = 1n;
const UNOBSERVABLE = 2n;
const FEES = { performanceFeeBps: 1000, managementFeeBps: 200 };

// The test provider does not decode custom errors, so match on the selector.
function revertsWith(contract, name) {
  const selector = contract.interface.getError(name).selector;
  return (error) => error?.revert?.name === name || String(error?.message).includes(selector);
}

async function ageMark(f, seconds) {
  const markedAt = await f.venue.updatedAt();
  await f.chain.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(markedAt) + seconds] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
}

async function registered(f, limits = BASE_LIMITS) {
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  await (await registry.registerAgent(f.vaultAddress, f.adapterAddress, limits, FEES, ZeroHash)).wait();
  return registry;
}

test("configure() refuses a mandate with no loss cap or no mark age, or either past this version's range", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  assert.equal(await f.guard.MAX_DRAWDOWN_BPS_CAP(), 5_000n);
  assert.equal(await f.guard.MAX_MARK_AGE_CAP(), 60n);
  for (const bad of [
    { maxDrawdownBps: 0 },
    { maxDrawdownBps: 5_001 },
    { maxMarkAgeSeconds: 0 },
    { maxMarkAgeSeconds: 61 }
  ]) {
    await assert.rejects(f.guard.configure(f.vaultAddress, { ...BASE_LIMITS, ...bad }), revertsWith(f.guard, "InvalidLossTerms"), JSON.stringify(bad));
  }
  // Both ends of the range are accepted.
  await (await f.guard.configure(f.vaultAddress, { ...BASE_LIMITS, maxDrawdownBps: 1, maxMarkAgeSeconds: 1 })).wait();
  await (await f.guard.configure(f.vaultAddress, { ...BASE_LIMITS, maxDrawdownBps: 5_000, maxMarkAgeSeconds: 60 })).wait();
});

test("a vault whose mark stops updating can be frozen by anyone, only after three mark ages", async (t) => {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 });
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();

  // Past one mark age poke() can no longer check the vault, but it is not yet unobservable.
  await ageMark(f, 20);
  await assert.rejects(f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress), revertsWith(f.guard, "MarkTooOld"));
  await assert.rejects(f.guard.connect(f.outsider).freezeUnobservable(f.vaultAddress), revertsWith(f.guard, "StillObservable"));

  await ageMark(f, 31);
  const outsider = await f.outsider.getAddress();
  const before = await f.usdc.balanceOf(outsider);
  const receipt = await (await f.guard.connect(f.outsider).freezeUnobservable(f.vaultAddress)).wait();
  assert.equal(await f.vault.state(), 1n, "Frozen");
  assert.ok((await f.usdc.balanceOf(outsider)) > before, "the caller is paid the freeze bounty");
  const event = receipt.logs.map((log) => { try { return f.guard.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "Unobservable");
  assert.equal(event.args.caller, outsider);

  const [reason, frozenAt] = await f.guard.freezeOf(f.vaultAddress);
  assert.equal(reason, UNOBSERVABLE);
  assert.equal(frozenAt, BigInt((await f.provider.getBlock(receipt.blockNumber)).timestamp));

  // The agent is stopped; a second freeze is refused by the vault.
  await assert.rejects(f.vault.connect(f.agent).execute(f.adapterAddress, f.order));
  await assert.rejects(f.guard.connect(f.outsider).freezeUnobservable(f.vaultAddress), revertsWith(f.vault, "AgentNotActive"));
});

test("the unobservable freeze needs configured terms and a funded vault", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  await ageMark(f, 600);
  await assert.rejects(f.guard.freezeUnobservable(f.vaultAddress), revertsWith(f.guard, "NothingToProtect"));
  const stranger = await f.deploy("MandateVault", "MandateVault", [
    await f.usdc.getAddress(), await f.guard.getAddress(), await f.agent.getAddress(), f.adapterAddress
  ]);
  await assert.rejects(f.guard.freezeUnobservable(await stranger.getAddress()), revertsWith(f.guard, "LimitsNotConfigured"));
});

test("a drawdown freeze is recorded with its own reason", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 1n);
  const [reason] = await f.guard.freezeOf(f.vaultAddress);
  assert.equal(reason, DRAWDOWN);
});

test("recordOutcome reads the chain: nothing for an active vault, then Frozen, then Closed", async (t) => {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 });
  const registry = await registered(f, { ...BASE_LIMITS, maxMarkAgeSeconds: 10 });
  await assert.rejects(registry.connect(f.outsider).recordOutcome(f.vaultAddress), revertsWith(registry, "NothingToRecord"));
  await assert.rejects(registry.recordOutcome(await f.outsider.getAddress()), revertsWith(registry, "NotRegistered"));

  await ageMark(f, 31);
  await (await f.guard.connect(f.keeper).freezeUnobservable(f.vaultAddress)).wait();
  await (await registry.connect(f.outsider).recordOutcome(f.vaultAddress)).wait();
  let outcome = await registry.outcomeOf(f.vaultAddress);
  const [, frozenAt] = await f.guard.freezeOf(f.vaultAddress);
  assert.equal(outcome.state, 1n);
  assert.equal(outcome.reason, UNOBSERVABLE);
  assert.equal(outcome.frozenAt, frozenAt);
  await assert.rejects(registry.recordOutcome(f.vaultAddress), revertsWith(registry, "NothingToRecord"), "the same state twice");

  // Nothing on the book, so the first unwind closes the vault.
  await (await f.vault.connect(f.keeper).unwind()).wait();
  assert.equal(await f.vault.state(), 2n);
  await (await registry.recordOutcome(f.vaultAddress)).wait();
  outcome = await registry.outcomeOf(f.vaultAddress);
  assert.equal(outcome.state, 2n);
  assert.equal(outcome.reason, UNOBSERVABLE, "the reason the vault stopped is kept after it closes");
  assert.equal(outcome.frozenAt, frozenAt);
});

test("only the vault's own agent can list a registered vault under its address", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent.getAddress();
  const unregistered = await f.deploy("MandateRegistry", "MandateRegistry");
  await assert.rejects(unregistered.connect(f.agent).linkVault(f.vaultAddress), revertsWith(unregistered, "NotRegistered"));

  const registry = await registered(f);
  await assert.rejects(registry.connect(f.outsider).linkVault(f.vaultAddress), revertsWith(registry, "OnlyVaultAgent"));
  await assert.rejects(registry.linkVault(f.vaultAddress), revertsWith(registry, "OnlyVaultAgent"), "not even the guard owner");
  assert.deepEqual([...await registry.vaultsOf(agent)], []);

  await (await registry.connect(f.agent).linkVault(f.vaultAddress)).wait();
  assert.deepEqual([...await registry.vaultsOf(agent)], [f.vaultAddress]);
  assert.equal(await registry.linked(f.vaultAddress), true);
  await assert.rejects(registry.connect(f.agent).linkVault(f.vaultAddress), revertsWith(registry, "AlreadyLinked"));
});
