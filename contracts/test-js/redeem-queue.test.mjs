import assert from "node:assert/strict";
import test from "node:test";
import { BTC, setup, usd } from "./perpl-fixture.mjs";

// A redemption larger than the vault's idle cash. On Perpl an open position keeps its
// margin at the venue, so withdraw() alone pays part and leaves the rest in shares
// until the agent frees cash. requestRedeem() gives the agent REDEEM_NOTICE to do that;
// after it, deleverageForRedemption() lets anyone take enough off the book.

const DAY = 24 * 60 * 60;

function revertsWith(contract, name) {
  const selector = contract.interface.getError(name).selector;
  return (error) => error?.revert?.name === name || String(error?.message).includes(selector);
}

/// $1,000 in, a $1,800 BTC long: about $370 of margin sits at Perpl.
async function invested(t) {
  const s = await setup(t);
  await s.trade(0, "0.03", "60600");
  const shares = await s.vault.balanceOf(s.allocator.address);
  const later = async (seconds) => {
    await s.rpc("evm_increaseTime", [seconds]);
    await s.rpc("evm_mine");
    await s.fresh();
  };
  return { ...s, shares, later };
}

test("a due request takes enough of the position off for the allocator to leave in full", async (t) => {
  const s = await invested(t);
  const { vault, allocator, agent, keeper } = s;
  const part = (s.shares * 8n) / 10n; // about $800 against about $630 of cash
  await s.wait(vault.connect(allocator).requestRedeem(part));
  assert.equal(await vault.redeemSharesRequested(), part);

  // Before the notice runs out nobody can force it, and the requested shares stay put.
  await s.fresh();
  await assert.rejects(vault.connect(keeper).deleverageForRedemption(allocator.address), revertsWith(vault, "RedeemNoticePending"));
  await assert.rejects(vault.connect(allocator).transferShares(keeper.address, s.shares - part + 1n), revertsWith(vault, "SharesUnderRequest"));
  await s.wait(vault.connect(allocator).transferShares(keeper.address, 1n)); // the unrequested part moves freely

  await s.later(DAY);
  const lotsBefore = await s.lots(BTC);
  await s.wait(vault.connect(keeper).deleverageForRedemption(allocator.address));
  const lotsAfter = await s.lots(BTC);
  // Part of the position, not all of it: about half closes, with the buffer.
  assert.ok(lotsAfter > 0n && lotsAfter < lotsBefore, `lots ${lotsBefore} -> ${lotsAfter}`);
  assert.ok(lotsAfter > lotsBefore / 3n, `closed more than needed: ${lotsAfter}`);
  // The step restarts the request's notice: it cannot be forced again tomorrow-minus-a-block.
  await s.fresh();
  await assert.rejects(vault.connect(keeper).deleverageForRedemption(allocator.address), revertsWith(vault, "RedeemNoticePending"));

  // For the grace period the agent may reduce but not add.
  await s.fresh();
  await assert.rejects(vault.connect(agent).execute(s.adapter.target, s.order(0, "0.001", "60600")),
    revertsWith(vault, "RedemptionDeleveraging"));
  await s.trade(0, "-0.001", "59400");
  // After it the agent trades normally again; a small add leaves the freed cash covering the claim.
  await s.later(60 * 60);
  await s.trade(0, "0.001", "60600");

  // The allocator's shares now redeem in full: none left over.
  const [equity] = await vault.markedAssets();
  const owed = (part * equity) / (await vault.totalSupply());
  const before = await s.usdc.balanceOf(allocator.address);
  await s.wait(vault.connect(allocator).withdraw(part, allocator.address));
  const paid = (await s.usdc.balanceOf(allocator.address)) - before;
  assert.equal(paid, owed);
  assert.equal((await vault.redeemRequestOf(allocator.address)).shares, 0n);
  assert.equal(await vault.redeemSharesRequested(), 0n);
});

test("withdraw() without a request pays only the cash, and a request reaches the rest", async (t) => {
  const s = await invested(t);
  const { vault, allocator, keeper } = s;
  const cash = await s.usdc.balanceOf(vault.target);
  await s.fresh();
  await s.wait(vault.connect(allocator).withdraw(s.shares, allocator.address));
  const left = await vault.balanceOf(allocator.address);
  assert.ok(left > 0n, "part of the claim stays in shares");
  assert.equal(await s.usdc.balanceOf(vault.target), 0n);
  assert.ok(cash > 0n);

  await s.wait(vault.connect(allocator).requestRedeem(left));
  await s.later(DAY);
  await s.wait(vault.connect(keeper).deleverageForRedemption(allocator.address));
  // Everything was at the venue, so the step closes the whole position.
  assert.equal(await s.lots(BTC), 0n);
  await s.fresh();
  await s.wait(vault.connect(allocator).withdraw(left, allocator.address));
  assert.equal(await vault.balanceOf(allocator.address), 0n);
});

test("a request the cash already covers, or none at all, forces nothing", async (t) => {
  const s = await invested(t);
  const { vault, allocator, keeper } = s;
  await assert.rejects(vault.connect(keeper).deleverageForRedemption(allocator.address), revertsWith(vault, "NoRedeemRequest"));
  await assert.rejects(vault.connect(allocator).requestRedeem(s.shares + 1n), revertsWith(vault, "InsufficientShares"));

  await s.wait(vault.connect(allocator).requestRedeem(s.shares / 10n)); // about $100
  await s.later(DAY);
  await assert.rejects(vault.connect(keeper).deleverageForRedemption(allocator.address), revertsWith(vault, "CashCoversRedeem"));

  // Adding to a request restarts its notice.
  await s.wait(vault.connect(allocator).requestRedeem((s.shares * 7n) / 10n));
  await s.fresh();
  await assert.rejects(vault.connect(keeper).deleverageForRedemption(allocator.address), revertsWith(vault, "RedeemNoticePending"));
  const requested = s.shares / 10n + (s.shares * 7n) / 10n;
  assert.equal(await vault.redeemSharesRequested(), requested);

  // A withdrawal counts against the request; the total follows it.
  await s.wait(vault.connect(allocator).withdraw(s.shares / 20n, allocator.address));
  assert.equal(await vault.redeemSharesRequested(), requested - s.shares / 20n);

  await s.wait(vault.connect(allocator).cancelRedeem());
  assert.equal((await vault.redeemRequestOf(allocator.address)).shares, 0n);
  assert.equal(await vault.redeemSharesRequested(), 0n);
  await s.later(DAY);
  await assert.rejects(vault.connect(keeper).deleverageForRedemption(allocator.address), revertsWith(vault, "NoRedeemRequest"));
  assert.equal(await s.lots(BTC), 3_000n);
});

test("a frozen vault is unwound, not deleveraged", async (t) => {
  const s = await setup(t, { trade: { maxHoldingSeconds: 5 } });
  await s.trade(0, "0.03", "60600");
  const shares = await s.vault.balanceOf(s.allocator.address);
  await s.wait(s.vault.connect(s.allocator).requestRedeem(shares));
  await s.freeze();
  await s.rpc("evm_increaseTime", [DAY]);
  await s.rpc("evm_mine");
  await s.fresh();
  await assert.rejects(s.vault.connect(s.keeper).deleverageForRedemption(s.allocator.address),
    revertsWith(s.vault, "AgentNotActive"));
});
