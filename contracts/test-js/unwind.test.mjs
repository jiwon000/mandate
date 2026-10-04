import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "ethers";
import { coder, fixture } from "./fixture.mjs";

// 0.5 ETH bought at $2000, marked at $1800: -$100 of equity, 10% drawdown against
// a 2% limit. poke() freezes the vault and pays 0.5 mUSDC to the keeper.
async function frozenFixture(t, overrides = {}) {
  const f = await fixture(t, overrides);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 1n, "Frozen");
  assert.equal(await f.vault.totalAssets(), parseUnits("999.5", 6), "cash after the poke bounty");
  return f;
}

function eventsNamed(receipt, contract, name) {
  return receipt.logs
    .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .filter((l) => l?.name === name);
}

test("unwind is only for frozen vaults, and reduce is only for the vault", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await assert.rejects(f.vault.connect(f.outsider).unwind(), /NotFrozen|revert/);
  await assert.rejects(f.adapter.connect(f.outsider).reduce(f.vaultAddress, 2000), /OnlyVault|revert/);
  assert.equal(await f.vault.state(), 0n, "still Active, position untouched");
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.5", 18));
});

test("five permissionless steps take the frozen position off the book and close the vault", async (t) => {
  const f = await frozenFixture(t);
  const outsiderAddress = await f.outsider.getAddress();
  assert.equal(await f.usdc.balanceOf(outsiderAddress), 0n);

  // Step 1 closes a fifth of the size at freeze: 0.1 ETH at $1800.
  let receipt = await (await f.vault.connect(f.outsider).unwind()).wait();
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.4", 18));
  const [unwound] = eventsNamed(receipt, f.vault, "Unwound");
  assert.equal(unwound.args.step, 1n);
  assert.equal(unwound.args.closedNotional, parseUnits("180", 18), "0.1 ETH x $1800");
  assert.equal(unwound.args.realizedPnl, parseUnits("-20", 18), "a fifth of the $100 loss is now realised");
  assert.equal(unwound.args.bounty, 99_950n, "0.01% of 999.5 mUSDC");
  assert.equal(await f.vault.state(), 1n, "still Frozen with 0.4 ETH open");
  assert.equal(await f.vault.unwindStepsDone(), 1n);

  // Step 2 closes a quarter of what is left: the same 0.1 ETH.
  await (await f.vault.connect(f.outsider).unwind()).wait();
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.3", 18));

  await (await f.vault.connect(f.outsider).unwind()).wait();
  await (await f.vault.connect(f.outsider).unwind()).wait();
  assert.equal(await f.vault.state(), 1n, "four steps in, a sliver is still open");

  receipt = await (await f.vault.connect(f.outsider).unwind()).wait();
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), 0n, "the last step closes whatever remains");
  assert.equal(eventsNamed(receipt, f.vault, "Closed").length, 1, "Closed emitted once");
  assert.equal(await f.vault.state(), 2n, "Closed");
  assert.equal(await f.vault.unwindStepsDone(), 5n);

  // Five bounties of 0.01% on a cash balance that shrinks by each one.
  assert.equal(await f.usdc.balanceOf(outsiderAddress), 499_650n);
  const cash = await f.vault.totalAssets();
  assert.equal(cash, parseUnits("999.000350", 6));

  // The mock venue keeps a cash-flow basis, so the $100 loss is now realised inside
  // netCost rather than sitting in an open position. Equity = cash - $100.
  assert.equal(await f.venue.unrealizedPnlE18(f.vaultAddress), parseUnits("-100", 18));
  const [equity] = await f.adapter.markEquity(f.vaultAddress);
  assert.equal(equity, cash - parseUnits("100", 6));
});

test("a closed vault is terminal: no trades, no deposits, no more unwinding", async (t) => {
  const f = await frozenFixture(t);
  for (let i = 0; i < 5; i += 1) await (await f.vault.connect(f.keeper).unwind()).wait();
  assert.equal(await f.vault.state(), 2n);

  await assert.rejects(f.vault.connect(f.agent).execute(f.adapterAddress, f.order), /AgentNotActive|revert/);
  const allocatorAddress = await f.fund(f.allocator, parseUnits("10", 6));
  await assert.rejects(f.vault.connect(f.allocator).allocate(parseUnits("10", 6), allocatorAddress), /AgentNotActive|revert/);
  await assert.rejects(f.vault.connect(f.keeper).unwind(), /NotFrozen|revert/);
});

test("a stale mark holds a frozen withdrawal but not a closed one", async (t) => {
  const f = await frozenFixture(t, { maxMarkAgeSeconds: 60 });
  const allocatorAddress = await f.allocator.getAddress();
  const shares = await f.vault.balanceOf(allocatorAddress);

  // Nobody refreshes the price for ten minutes.
  const markedAt = await f.venue.updatedAt();
  await f.chain.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(markedAt) + 600] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });

  // Frozen with an open position: redeeming against a price nobody vouches for is refused.
  await assert.rejects(
    f.vault.connect(f.allocator).withdraw(shares, allocatorAddress),
    /MarkTooOld|revert/,
    "an open position priced off a stale mark cannot be redeemed"
  );

  // Unwinding needs no fresh mark: the venue fills at its own price.
  for (let i = 0; i < 5; i += 1) await (await f.vault.connect(f.keeper).unwind()).wait();
  assert.equal(await f.vault.state(), 2n, "Closed");

  // Closed: nothing is left to misprice, so the same stale mark no longer blocks the exit.
  const [equity] = await f.adapter.markEquity(f.vaultAddress);
  const supply = await f.vault.totalSupply();
  const expected = (shares * equity) / supply;
  await (await f.vault.connect(f.allocator).withdraw(shares, allocatorAddress)).wait();
  assert.equal(await f.usdc.balanceOf(allocatorAddress), expected, "paid the marked share of cash plus realised PnL");
  assert.equal(await f.vault.balanceOf(allocatorAddress), 0n, "every share redeemed in one call");
  assert.ok(expected < await f.vault.totalAssets() + expected, "paid out of cash, no position left to lean on");
});

test("one unwind step per block", async (t) => {
  const f = await frozenFixture(t);
  await f.chain.provider.request({ method: "evm_setAutomine", params: [false] });
  // With automine off the node's pending block already holds the first call, so a
  // gas estimate for the second one would fail before it is ever sent. Fixed gas
  // limits get both into the same block.
  const first = await f.vault.connect(f.keeper).unwind({ gasLimit: 400_000 });
  const second = await f.vault.connect(f.outsider).unwind({ gasLimit: 400_000 });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
  await f.chain.provider.request({ method: "evm_setAutomine", params: [true] });

  const firstReceipt = await f.provider.getTransactionReceipt(first.hash);
  const secondReceipt = await f.provider.getTransactionReceipt(second.hash);
  assert.equal(firstReceipt.blockNumber, secondReceipt.blockNumber, "both landed in one block");
  assert.equal(firstReceipt.status, 1, "the first step closes 0.1 ETH");
  assert.equal(secondReceipt.status, 0, "the second reverts with UnwindCooldown");
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.4", 18));
  assert.equal(await f.vault.unwindStepsDone(), 1n);
});

test("a frozen vault with nothing on the book closes on the first call", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  // The agent sells the whole 0.5 ETH at $1800 itself: the $100 loss is realised
  // and the position is flat, but NAV per share is still 10% under its high-water mark.
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  const close = coder.encode(["int256", "uint256"], [parseUnits("-0.5", 18), parseUnits("1700", 18)]);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, close)).wait();
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), 0n);
  assert.equal(await f.vault.state(), 1n, "checkAfter froze it on the realised drawdown");

  const receipt = await (await f.vault.connect(f.keeper).unwind()).wait();
  assert.equal(await f.vault.state(), 2n, "nothing to reduce, straight to Closed");
  assert.equal(await f.vault.unwindStepsDone(), 0n, "no reduce step was spent");
  const [unwound] = eventsNamed(receipt, f.vault, "Unwound");
  assert.equal(unwound.args.closedNotional, 0n);
  assert.equal(eventsNamed(receipt, f.vault, "Closed").length, 1);
});
