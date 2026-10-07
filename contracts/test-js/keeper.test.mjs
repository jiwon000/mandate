import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "ethers";
import { keeperTick } from "../script/keeper-core.mjs";
import { fixture } from "./fixture.mjs";

// The keeper is a stranger: it owns nothing and holds no role in the vault.
async function setup(t, limits) {
  const f = await fixture(t, limits);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  const keeperAddress = await f.keeper.getAddress();
  const args = {
    guard: f.guard.connect(f.keeper),
    vaults: [{ address: f.vaultAddress, name: "vault", contract: f.vault }],
    signer: f.keeper
  };
  const blockNumber = () => f.provider.getBlockNumber();
  return { f, args, keeperAddress, blockNumber };
}

test("a drawdown past the limit freezes the vault and pays the keeper", async (t) => {
  const { f, args, keeperAddress } = await setup(t);
  await (await f.venue.setPrice(parseUnits("1900", 18))).wait(); // -5% of NAV vs a 2% limit

  const [action] = await keeperTick(args);

  assert.equal(action.action, "poke");
  assert.equal(action.froze, true);
  assert.match(action.reason, /drawdown 500bps > 200/);
  assert.equal(await f.vault.state(), 1n, "Frozen");
  assert.equal(await f.usdc.balanceOf(keeperAddress), (parseUnits("1000", 6) * 5n) / 10_000n, "poke bounty");
});

test("later ticks unwind a frozen vault one step at a time to Closed", async (t) => {
  const { f, args, keeperAddress } = await setup(t);
  await (await f.venue.setPrice(parseUnits("1900", 18))).wait();
  await keeperTick(args);
  const afterPoke = await f.usdc.balanceOf(keeperAddress);

  for (let step = 1; step <= 5; step += 1) {
    // eth_call simulates in the latest block, where the previous unwind already
    // used this block's slot; a real tick comes seconds later.
    await f.chain.provider.request({ method: "evm_mine", params: [] });
    const [action] = await keeperTick(args);
    assert.equal(action.action, "unwind", `tick ${step}`);
    assert.equal(await f.vault.unwindStepsDone(), BigInt(step));
  }
  assert.equal(await f.vault.state(), 2n, "Closed");
  assert.ok((await f.usdc.balanceOf(keeperAddress)) > afterPoke, "unwind bounties paid");

  const [done] = await keeperTick(args);
  assert.equal(done.action, "none");
  assert.equal(done.reason, "closed");
});

test("a healthy vault gets no transaction", async (t) => {
  const { f, args, blockNumber } = await setup(t);
  await (await f.venue.setPrice(parseUnits("1980", 18))).wait(); // -1% of NAV vs a 2% limit
  const before = await blockNumber();

  const [action] = await keeperTick(args);

  assert.equal(action.action, "none");
  assert.equal(action.txHash, undefined);
  assert.equal(await blockNumber(), before, "no block mined, so nothing was sent");
  assert.equal(await f.vault.state(), 0n, "still Active");
});

test("mark mode pokes a healthy vault, observe mode never freezes", async (t) => {
  const { f, args, blockNumber } = await setup(t);
  await (await f.venue.setPrice(parseUnits("1980", 18))).wait();
  const before = await blockNumber();

  const [marked] = await keeperTick({ ...args, mode: "mark" });
  assert.equal(marked.action, "poke");
  assert.equal(marked.froze, false);
  assert.equal(await blockNumber(), before + 1);

  await (await f.venue.setPrice(parseUnits("1900", 18))).wait();
  const [observed] = await keeperTick({ ...args, mode: "observe" });
  assert.equal(observed.action, "observe");
  assert.equal(await f.vault.state(), 0n, "observe() does not freeze");
});

test("a mark three ages old is frozen as unobservable", async (t) => {
  const { f, args, keeperAddress } = await setup(t);
  const [, markedAt] = await f.vault.markedAssets();

  // Two ages old: poke() would revert MarkTooOld, but the vault is not yet unobservable
  // and no limit is breached, so there is nothing to send.
  await f.chain.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(markedAt) + 120] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
  const [waiting] = await keeperTick(args);
  assert.equal(waiting.action, "none");
  assert.equal(await f.vault.state(), 0n);

  await f.chain.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(markedAt) + 181] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
  const [action] = await keeperTick(args);

  assert.equal(action.action, "freezeUnobservable");
  assert.equal(await f.vault.state(), 1n, "Frozen");
  assert.equal(await f.usdc.balanceOf(keeperAddress), (parseUnits("1000", 6) * 5n) / 10_000n, "bounty paid");
});

test("a vault frozen for a stopped feed is resumed, not unwound, when the feed comes back", async (t) => {
  const { f, args } = await setup(t, { maxMarkAgeSeconds: 10 });
  await f.chain.provider.request({ method: "evm_increaseTime", params: [31] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
  let [action] = await keeperTick(args);
  assert.equal(action.action, "freezeUnobservable");

  // Inside the recovery window, still no feed: nothing to resume and no unwind yet.
  [action] = await keeperTick(args);
  assert.equal(action.action, "skip");
  assert.match(action.reason, /unwind/);

  await (await f.venue.setPrice(parseUnits("2000", 18))).wait();
  [action] = await keeperTick(args);
  assert.equal(action.action, "resume");
  assert.equal(await f.vault.state(), 0n, "Active");
});
