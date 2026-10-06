import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits, keccak256, AbiCoder } from "ethers";
import { fixture, BASE_LIMITS, coder, termsHashOf } from "./fixture.mjs";

// Roadmap item 10: a realised-volatility estimate built from the marks the guard
// observes, and a pre-trade stress test on orders that add exposure.
//
// The guard's arithmetic is reproduced here in BigInt so the tests pin the numbers
// and not just the sign of the decision.

const ONE = 10n ** 18n;
const STRESS = { volWindowSeconds: 60, stressHorizonSeconds: 60, stressSigmasX10: 30 };

const isqrt = (n) => {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Newton from a float seed; exact for any n once it settles.
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
};

// v' = (window * v + r^2) / (window + dt), r = |p1 - p0| / p0 in 1e18.
const stepVariance = (v, p0, p1, dt, window) => {
  const diff = p1 > p0 ? p1 - p0 : p0 - p1;
  let r = (diff * ONE) / p0;
  if (r > 10n * ONE) r = 10n * ONE;
  return (BigInt(window) * v + r * r) / (BigInt(window) + BigInt(dt));
};
const sigmaBpsOf = (v, horizon) => isqrt(v * BigInt(horizon)) / 10n ** 14n;

// Every fixture transaction mines a block, so "N seconds after the last mark" has to be
// anchored on the latest block, not on the mark. Returns the seconds the mark aged.
async function pushPrice(f, priceE18, gap) {
  const before = Number(await f.venue.updatedAt());
  const latest = (await f.provider.getBlock("latest")).timestamp;
  const at = latest + gap;
  await f.chain.provider.request({ method: "evm_setNextBlockTimestamp", params: [at] });
  await (await f.venue.setPrice(priceE18)).wait();
  assert.equal(await f.venue.updatedAt(), BigInt(at));
  return at - before;
}

test("the variance estimate follows the mark series, normalised by the seconds between marks", async (t) => {
  const f = await fixture(t, STRESS);
  const adapter = f.adapterAddress;

  // First observation seeds the price and nothing else.
  await (await f.guard.connect(f.keeper).observe(f.vaultAddress, adapter)).wait();
  let vol = await f.guard.volOf(f.vaultAddress);
  const p0 = await f.venue.priceE18();
  assert.equal(vol.lastPriceE18, p0);
  assert.equal(vol.lastPriceAt, await f.venue.updatedAt());
  assert.equal(vol.varRatePerSecond, 0n);

  // +1% about 10s later, then -2% about 40s after that.
  const p1 = (p0 * 101n) / 100n;
  const dt1 = await pushPrice(f, p1, 10);
  await (await f.guard.connect(f.keeper).observe(f.vaultAddress, adapter)).wait();
  vol = await f.guard.volOf(f.vaultAddress);
  let expected = stepVariance(0n, p0, p1, dt1, STRESS.volWindowSeconds);
  assert.equal(vol.varRatePerSecond, expected);

  const p2 = (p1 * 98n) / 100n;
  const dt2 = await pushPrice(f, p2, 40);
  await (await f.guard.connect(f.keeper).observe(f.vaultAddress, adapter)).wait();
  vol = await f.guard.volOf(f.vaultAddress);
  expected = stepVariance(expected, p1, p2, dt2, STRESS.volWindowSeconds);
  assert.equal(vol.varRatePerSecond, expected);
  assert.equal(vol.lastPriceE18, p2);

  // A second observation of the same mark changes nothing.
  await (await f.guard.connect(f.keeper).observe(f.vaultAddress, adapter)).wait();
  assert.equal((await f.guard.volOf(f.vaultAddress)).varRatePerSecond, expected);

  // The quote is sigma over the horizon, k of them, and the loss at the given leverage
  // as a drawdown. Below the high-water mark the price drop itself is part of it, so
  // check the quote at par: 1x leverage, move = loss.
  const sigma = sigmaBpsOf(expected, STRESS.stressHorizonSeconds);
  const move = (sigma * BigInt(STRESS.stressSigmasX10)) / 10n;
  const [qSigma, qMove, qDd] = await f.guard.stressQuote(f.vaultAddress, adapter, 100);
  assert.equal(qSigma, sigma);
  assert.equal(qMove, move);
  // Flat vault, NAV at par: a 1x position under the move loses exactly move bps.
  assert.equal(qDd, move);
  assert.ok(sigma > 0n, "two moves must leave a non-zero sigma");
});

test("after a shock an order that adds exposure reverts StressBreach; one that reduces it passes", async (t) => {
  const f = await fixture(t, STRESS);
  const adapter = f.adapterAddress;
  await (await f.guard.connect(f.keeper).observe(f.vaultAddress, adapter)).wait();
  const p0 = await f.venue.priceE18();

  // Calm tape: the estimate is still zero, so the 1.00x opening order passes.
  await (await f.vault.connect(f.agent).execute(adapter, f.order)).wait();

  // A 1% drop within a few seconds. Drawdown is 1% at 1x, inside the 2% limit: no freeze.
  const p1 = (p0 * 99n) / 100n;
  await pushPrice(f, p1, 5);
  await (await f.guard.connect(f.keeper).observe(f.vaultAddress, adapter)).wait();
  const [, , drawdownBps] = await f.guard.quote(f.vaultAddress, adapter);
  assert.equal(drawdownBps, 100n);
  assert.equal(await f.vault.state(), 0n);

  // Add 0.25 ETH on top of 0.5: 1.5x on the marked equity. The stressed drawdown is
  // the 1% already lost plus 1.5 x the 3-sigma move, past the 2% limit.
  const add = coder.encode(["int256", "uint256"], [parseUnits("0.25", 18), p1 * 2n]);
  const preview = await f.adapter.preview(f.vaultAddress, add);
  assert.equal(preview.expectedLeverageX100, 150n);
  const [sigma, move, stressedDd] = await f.guard.stressQuote(f.vaultAddress, adapter, 150);
  assert.ok(stressedDd > 200n, `stressed drawdown ${stressedDd} should exceed the 200 bps limit`);

  let caught = null;
  try {
    await f.vault.connect(f.agent).execute.staticCall(adapter, add);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "the order should have reverted");
  const data = caught.data ?? caught.info?.error?.data ?? caught.error?.data;
  const parsed = f.guard.interface.parseError(data);
  assert.equal(parsed.name, "StressBreach");
  assert.deepEqual([...parsed.args].map(BigInt), [sigma, move, stressedDd]);
  await assert.rejects(f.vault.connect(f.agent).execute(adapter, add), /StressBreach|revert/);

  // Nothing about the position changed on the venue.
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.5", 18));

  // Taking 0.1 ETH off is never stress-tested, whatever the estimate says.
  const reduce = coder.encode(["int256", "uint256"], [-parseUnits("0.1", 18), 0n]);
  await (await f.vault.connect(f.agent).execute(adapter, reduce)).wait();
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.4", 18));
});

test("a vault without a window is not stress-tested and never writes volatility state", async (t) => {
  const f = await fixture(t); // BASE_LIMITS: volWindowSeconds 0
  const adapter = f.adapterAddress;
  const p0 = await f.venue.priceE18();
  await (await f.vault.connect(f.agent).execute(adapter, f.order)).wait();

  const p1 = (p0 * 99n) / 100n;
  await pushPrice(f, p1, 5);
  await (await f.guard.connect(f.keeper).observe(f.vaultAddress, adapter)).wait();
  const vol = await f.guard.volOf(f.vaultAddress);
  assert.equal(vol.lastPriceAt, 0n);
  assert.deepEqual([...(await f.guard.stressQuote(f.vaultAddress, adapter, 150))], [0n, 0n, 0n]);

  // Same order that StressBreach refused above goes through here.
  const add = coder.encode(["int256", "uint256"], [parseUnits("0.25", 18), p1 * 2n]);
  await (await f.vault.connect(f.agent).execute(adapter, add)).wait();
  assert.equal(await f.venue.positionSizeE18(f.vaultAddress), parseUnits("0.75", 18));
});

test("poke() and trades feed the estimate too; observe() needs a configured vault and an allowed adapter", async (t) => {
  const f = await fixture(t, STRESS);
  const adapter = f.adapterAddress;
  const p0 = await f.venue.priceE18();

  // Seed through poke().
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, adapter)).wait();
  assert.equal((await f.guard.volOf(f.vaultAddress)).lastPriceE18, p0);

  // A trade after a new mark observes it in checkAndConsumeBefore.
  const p1 = (p0 * 1005n) / 1000n;
  const dt = await pushPrice(f, p1, 20);
  await (await f.vault.connect(f.agent).execute(adapter, f.order)).wait();
  const vol = await f.guard.volOf(f.vaultAddress);
  assert.equal(vol.lastPriceE18, p1);
  assert.equal(vol.varRatePerSecond, stepVariance(0n, p0, p1, dt, STRESS.volWindowSeconds));

  await assert.rejects(
    f.guard.connect(f.keeper).observe(await f.outsider.getAddress(), adapter),
    /LimitsNotConfigured|revert/
  );
  await assert.rejects(
    f.guard.connect(f.keeper).observe(f.vaultAddress, await f.outsider.getAddress()),
    /AdapterNotAllowed|revert/
  );
});

test("a window without a horizon or a sigma multiple is refused at configure(); the terms hash covers all three", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  await assert.rejects(
    f.guard.configure(f.vaultAddress, { ...BASE_LIMITS, volWindowSeconds: 60 }),
    /InvalidStressTerms|revert/
  );
  await assert.rejects(
    f.guard.configure(f.vaultAddress, { ...BASE_LIMITS, volWindowSeconds: 60, stressHorizonSeconds: 60 }),
    /InvalidStressTerms|revert/
  );
  await (await f.guard.configure(f.vaultAddress, { ...BASE_LIMITS, ...STRESS })).wait();

  const hashOf = (l) => termsHashOf(l);
  assert.equal(await f.guard.termsHash(f.vaultAddress), hashOf({ ...BASE_LIMITS, ...STRESS }));
  assert.notEqual(hashOf({ ...BASE_LIMITS, ...STRESS }), hashOf({ ...BASE_LIMITS, ...STRESS, stressSigmasX10: 20 }));
});
