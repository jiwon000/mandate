import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "ethers";
import { coder, fixture } from "./fixture.mjs";

test("markEquity prices the open position, so equity moves without any trade", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();

  let [equity] = await f.adapter.markEquity(f.vaultAddress);
  assert.equal(equity, f.deposit, "no PnL at the entry price");

  // Price falls 10%. The agent does nothing; the USDC balance does not move.
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  assert.equal(await f.vault.totalAssets(), f.deposit, "cash balance is unchanged");

  [equity] = await f.adapter.markEquity(f.vaultAddress);
  assert.equal(equity, parseUnits("900", 6), "0.5 ETH x -$200 = -$100 of equity");

  const [nav, hwm, ddBps] = await f.guard.quote(f.vaultAddress, f.adapterAddress);
  assert.equal(nav, parseUnits("0.9", 18));
  assert.equal(hwm, parseUnits("1", 18));
  assert.equal(ddBps, 1000n, "10% drawdown");
});

test("poke is permissionless, freezes a breached vault, and pays the caller", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();

  assert.equal(await f.vault.state(), 0n, "Active before the poke");
  const keeperAddress = await f.keeper.getAddress();
  assert.equal(await f.usdc.balanceOf(keeperAddress), 0n);

  // A stranger with no role in the vault re-marks it.
  const receipt = await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();

  assert.equal(await f.vault.state(), 1n, "Frozen");
  const expectedBounty = (parseUnits("1000", 6) * 5n) / 10_000n;
  assert.equal(await f.usdc.balanceOf(keeperAddress), expectedBounty, "0.05% keeper bounty");

  const breach = receipt.logs
    .map((l) => { try { return f.guard.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "DrawdownBreach");
  assert.ok(breach, "DrawdownBreach emitted");
  assert.equal(breach.args.caller, keeperAddress);
  assert.equal(breach.args.drawdownBps, 1000n);
});

test("a within-limit move re-marks without freezing", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1980", 18))).wait(); // -1.0% of NAV

  const frozen = await f.guard.poke.staticCall(f.vaultAddress, f.adapterAddress);
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();

  assert.equal(frozen, false);
  assert.equal(await f.vault.state(), 0n, "still Active");
  const [, , ddBps] = await f.guard.quote(f.vaultAddress, f.adapterAddress);
  assert.equal(ddBps, 100n, "1% drawdown, under the 2% limit");
});

test("a frozen vault stops the agent but never traps the allocator", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();

  await assert.rejects(
    f.vault.connect(f.agent).execute(f.adapterAddress, f.order),
    "agent cannot trade once frozen"
  );
  const more = parseUnits("10", 6);
  await (await f.usdc.mint(await f.allocator.getAddress(), more)).wait();
  await (await f.usdc.connect(f.allocator).approve(f.vaultAddress, more)).wait();
  await assert.rejects(
    f.vault.connect(f.allocator).allocate(more, await f.allocator.getAddress()),
    "no new money into a frozen vault"
  );

  const allocatorAddress = await f.allocator.getAddress();
  const shares = await f.vault.balanceOf(allocatorAddress);
  await (await f.vault.connect(f.allocator).withdraw(shares, allocatorAddress)).wait();
  assert.equal(await f.vault.totalSupply(), 0n, "withdrawal still works while frozen");
  // 0.5 ETH bought at $2000 is $100 underwater at $1800, so the vault is worth
  // 899.5 even though 999.5 of cash is sitting in it. The allocator redeems at
  // the marked price and the position's loss stays behind as collateral instead
  // of walking out of the door with the last share.
  assert.equal(await f.usdc.balanceOf(allocatorAddress), parseUnits("909.5", 6));
  assert.equal(await f.vault.totalAssets(), parseUnits("100", 6), "the loss stays collateralised");
});

test("freezing twice is rejected, so the bounty is paid once", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();

  const balance = await f.usdc.balanceOf(await f.keeper.getAddress());
  await assert.rejects(f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress));
  assert.equal(await f.usdc.balanceOf(await f.keeper.getAddress()), balance);
});

test("a mark older than the limit is refused instead of trusted", async (t) => {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 });
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();

  const markedAt = await f.venue.updatedAt();
  await f.chain.provider.request({
    method: "evm_setNextBlockTimestamp",
    params: [Number(markedAt) + 600]
  });
  await f.chain.provider.request({ method: "evm_mine", params: [] });

  await assert.rejects(
    f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress),
    /MarkTooOld|revert/,
    "a 10-second freshness limit must not be satisfiable by a 600-second-old mark"
  );
  // The same limit blocks trading, not just poking.
  await assert.rejects(f.vault.connect(f.agent).execute(f.adapterAddress, f.order));

  await (await f.venue.setPrice(parseUnits("2000", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  assert.equal(await f.vault.state(), 0n, "a fresh mark restores normal operation");
});

test("leverage is measured against mark equity, not the idle cash balance", async (t) => {
  const f = await fixture(t, { maxLeverageX100: 120, maxDrawdownBps: 0 });
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();

  // Equity falls to $700 while the USDC balance still reads $1000.
  await (await f.venue.setPrice(parseUnits("1400", 18))).wait();
  const [equity] = await f.adapter.markEquity(f.vaultAddress);
  assert.equal(equity, parseUnits("700", 6));
  assert.equal(await f.vault.totalAssets(), parseUnits("1000", 6));

  // Adding 0.2 ETH takes the book to 0.7 ETH = $980 of notional.
  const addOn = coder.encode(["int256", "uint256"], [parseUnits("0.2", 18), parseUnits("1500", 18)]);
  const preview = await f.adapter.preview(f.vaultAddress, addOn);
  assert.equal(preview.expectedTotalNotional, parseUnits("980", 18));
  assert.equal(preview.expectedLeverageX100, 140n, "$980 / $700 equity = 1.40x");

  const cashBasedLeverage = (parseUnits("980", 18) * 100n) / parseUnits("1000", 18);
  assert.equal(cashBasedLeverage, 98n, "the old cash denominator would have read 0.98x");

  await assert.rejects(
    f.vault.connect(f.agent).execute(f.adapterAddress, addOn),
    "1.40x breaches the 1.20x limit; the cash denominator would have waved it through"
  );
});
