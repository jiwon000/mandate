import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "ethers";
import { coder, fixture } from "./fixture.mjs";

const usd = (amount) => parseUnits(amount, 6);

/// Marked NAV per share, scaled up so integer division does not hide the movement
/// this suite is about.
async function navPerShare(f) {
  const [equity] = await f.vault.markedAssets();
  const supply = await f.vault.totalSupply();
  return (equity * 10n ** 18n) / supply;
}

test("a late allocator cannot buy into someone else's unrealised profit", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();

  // 0.5 ETH bought at $2000 is $200 up at $2400. The vault still holds exactly
  // the 1,000 USDC it started with - the profit lives in the position.
  await (await f.venue.setPrice(parseUnits("2400", 18))).wait();
  const [equity] = await f.vault.markedAssets();
  assert.equal(equity, usd("1200"));
  assert.equal(await f.vault.totalAssets(), usd("1000"), "the cash balance has not moved");

  const before = await navPerShare(f);
  const outsider = await f.fund(f.outsider, usd("1200"));
  await (await f.vault.connect(f.outsider).allocate(usd("1200"), outsider)).wait();

  // Priced off cash, 1,200 USDC would have bought 1,200 shares - a 60% stake in a
  // vault the newcomer funded half of, paid for out of the first allocator's profit.
  assert.equal(await f.vault.balanceOf(outsider), usd("1000"), "1,200 USDC buys 1,000 shares at 1.20");
  assert.equal(await navPerShare(f), before, "an entry must not move NAV per share");

  const holder = await f.allocator.getAddress();
  const [after] = await f.vault.markedAssets();
  const supply = await f.vault.totalSupply();
  assert.equal(
    (await f.vault.balanceOf(holder)) * after / supply,
    usd("1200"),
    "the first allocator keeps all $200 of the gain"
  );
});

test("an allocator entering an underwater vault is not charged for the loss", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();

  const [equity] = await f.vault.markedAssets();
  assert.equal(equity, usd("900"), "$100 of the position is under water");

  const before = await navPerShare(f);
  const outsider = await f.fund(f.outsider, usd("450"));
  await (await f.vault.connect(f.outsider).allocate(usd("450"), outsider)).wait();

  // At 0.90 a share, 450 USDC is 500 shares. Cash pricing would have handed over
  // only 450 - the newcomer would have paid par for a share worth ninety cents and
  // quietly covered part of a loss booked before they arrived.
  assert.equal(await f.vault.balanceOf(outsider), usd("500"));
  assert.equal(await navPerShare(f), before, "an entry must not move NAV per share");
});

test("a redemption the cash cannot cover pays out and leaves the rest as shares", async (t) => {
  const f = await fixture(t);
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("2400", 18))).wait();

  const holder = await f.allocator.getAddress();
  const shares = await f.vault.balanceOf(holder);
  const before = await navPerShare(f);

  // The stake is worth 1,200 but only 1,000 of cash is in the vault: the other 200
  // is unrealised profit on a position nobody has closed. Reverting here would
  // trap the allocator behind the agent's book, so the vault pays what it has.
  await (await f.vault.connect(f.allocator).withdraw(shares, holder)).wait();
  assert.equal(await f.usdc.balanceOf(holder), usd("1000"), "every dollar of cash goes out");
  assert.equal(await f.vault.totalAssets(), 0n);

  const left = await f.vault.balanceOf(holder);
  assert.ok(left > 0n, "the unpaid claim stays with the allocator as shares");
  assert.equal(left, shares - usd("1000") * shares / usd("1200") - 1n, "the burn rounds up, by one unit");
  assert.ok(
    (await navPerShare(f)) >= before,
    "a partial exit must not dilute whoever stays; rounding breaks toward the vault"
  );
});

test("a stale mark blocks the door as well as the trade", async (t) => {
  const f = await fixture(t, { maxMarkAgeSeconds: 10 });
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();

  const markedAt = await f.venue.updatedAt();
  await f.chain.provider.request({
    method: "evm_setNextBlockTimestamp",
    params: [Number(markedAt) + 600]
  });
  await f.chain.provider.request({ method: "evm_mine", params: [] });

  // Pricing a share off a ten-minute-old mark is the same mistake as trading on
  // one, so both allocate() and withdraw() refuse rather than guess.
  const outsider = await f.fund(f.outsider, usd("100"));
  await assert.rejects(
    f.vault.connect(f.outsider).allocate(usd("100"), outsider),
    /MarkTooOld|revert/,
    "no minting against a price nobody can vouch for"
  );
  await assert.rejects(
    f.vault.connect(f.allocator).withdraw(usd("1"), await f.allocator.getAddress()),
    /MarkTooOld|revert/,
    "no redeeming against it either"
  );
});

test("the agent cannot trade on a venue the vault is not priced against", async (t) => {
  const f = await fixture(t);

  // A second adapter, fully registered on both the venue and the guard. It is a
  // legitimate route to a venue - just not this vault's, so its position would
  // never show up in markedAssets() and the shares would be priced off a book
  // that is missing half the risk.
  const other = await f.deploy("MockVenueAdapter", "MockVenueAdapter", [await f.venue.getAddress()]);
  const otherAddress = await other.getAddress();
  await (await f.venue.setAdapter(otherAddress, true)).wait();
  await (await f.guard.setAdapter(f.vaultAddress, otherAddress, true)).wait();

  await assert.rejects(
    f.vault.connect(f.agent).execute(otherAddress, f.order),
    /AdapterMismatch|revert/,
    "one vault, one venue"
  );
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.5", 18));
});
