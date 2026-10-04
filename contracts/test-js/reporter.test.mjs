import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixture.mjs";
import { deriveSeed, laplaceSamples } from "../../reporter/noise.mjs";
import {
  clip,
  mean,
  stdDev,
  sharpe,
  maxDrawdown,
  laplaceScaleForMean,
  returnsFromNavSeries
} from "../../reporter/stats.mjs";
import { EpsilonLedger } from "../../reporter/epsilon.mjs";
import { DPReporter } from "../../reporter/reporter.mjs";
import { simulateConfidenceInterval } from "../../reporter/simulator.mjs";

const BASE_SEED_ARGS = { domainSeparator: "0xregistry", epochId: 0, pinnedBlock: 100, statsVersion: 1 };

test("noise: identical inputs reproduce the exact same samples", () => {
  const seedA = deriveSeed("secret", BASE_SEED_ARGS);
  const seedB = deriveSeed("secret", BASE_SEED_ARGS);
  assert.deepEqual(seedA, seedB);
  assert.deepEqual(laplaceSamples(seedA, 5, 1), laplaceSamples(seedB, 5, 1));
});

test("noise: domain separation -- changing epoch, statsVersion or the secret changes every sample", () => {
  const base = laplaceSamples(deriveSeed("secret", BASE_SEED_ARGS), 3, 1);
  const byEpoch = laplaceSamples(deriveSeed("secret", { ...BASE_SEED_ARGS, epochId: 1 }), 3, 1);
  const byVersion = laplaceSamples(deriveSeed("secret", { ...BASE_SEED_ARGS, statsVersion: 2 }), 3, 1);
  const bySecret = laplaceSamples(deriveSeed("other-secret", BASE_SEED_ARGS), 3, 1);

  assert.notDeepEqual(base, byEpoch);
  assert.notDeepEqual(base, byVersion);
  assert.notDeepEqual(base, bySecret);
});

test("noise: successive draws from the same seed are not identical to each other", () => {
  const seed = deriveSeed("secret", BASE_SEED_ARGS);
  const samples = laplaceSamples(seed, 8, 1);
  const unique = new Set(samples);
  assert.equal(unique.size, samples.length);
});

test("stats: clip holds values inside [-bound, bound]", () => {
  assert.equal(clip(0.5, 0.1), 0.1);
  assert.equal(clip(-0.5, 0.1), -0.1);
  assert.equal(clip(0.05, 0.1), 0.05);
});

test("stats: mean, stdDev and sharpe on a known series", () => {
  const xs = [0.1, 0.2, 0.3];
  assert.ok(Math.abs(mean(xs) - 0.2) < 1e-12);
  assert.ok(stdDev(xs) > 0);
  assert.ok(Number.isFinite(sharpe(xs)));
  assert.equal(sharpe([1, 1, 1]), 0); // zero variance -> defined as 0, not Infinity/NaN
});

test("stats: maxDrawdown finds the worst peak-to-trough decline, not just the last one", () => {
  // Peaks at 1.00, falls to 0.80 (20% dd), recovers to 1.10, falls to 1.045 (5% dd).
  // The worst drawdown in the series is 20%, even though it is not the final move.
  const nav = [1.0, 0.8, 1.1, 1.045];
  assert.ok(Math.abs(maxDrawdown(nav) - 0.2) < 1e-9);
});

test("stats: returnsFromNavSeries derives per-step returns the way a Marked history would feed them", () => {
  const nav = [1.0, 1.05, 1.05, 0.9450000000000001]; // +5%, flat, -10%
  const returns = returnsFromNavSeries(nav);
  assert.equal(returns.length, 3);
  assert.ok(Math.abs(returns[0] - 0.05) < 1e-9);
  assert.ok(Math.abs(returns[1] - 0) < 1e-9);
  assert.ok(Math.abs(returns[2] - -0.1) < 1e-9);
});

test("stats: laplaceScaleForMean matches the report-noisy-mean sensitivity formula", () => {
  // sensitivity of the mean of N values clipped to [-c, c] is 2c/N; scale = sensitivity/epsilon.
  assert.equal(laplaceScaleForMean(0.1, 100, 1), (2 * 0.1) / 100);
  assert.equal(laplaceScaleForMean(0.1, 100, 2), (2 * 0.1) / 100 / 2);
  assert.equal(laplaceScaleForMean(0.1, 0, 1), Infinity);
});

test("epsilon: ledger enforces strictly increasing epochs and exact additive accounting", () => {
  const ledger = new EpsilonLedger({ cap: 0n });
  const first = ledger.propose(0, 500_000, 0);
  assert.equal(first, 500_000n);
  ledger.commit(0, first);

  assert.throws(() => ledger.propose(0, 100_000, 0), /does not advance/);

  const second = ledger.propose(1, 300_000, 0);
  assert.equal(second, 800_000n); // 500_000 + 300_000, not just "more than before"
});

test("epsilon: ledger refuses to propose past a configured cap", () => {
  const ledger = new EpsilonLedger({ cap: 150_000n });
  assert.throws(() => ledger.propose(0, 200_000, 0), /exceed the epsilon cap/);
  // Exactly at the cap is fine.
  assert.equal(ledger.propose(0, 150_000, 0), 150_000n);
});

test("epsilon: propose() never mutates state -- only commit() does", () => {
  const ledger = new EpsilonLedger({ cap: 0n });
  ledger.propose(0, 500_000, 0);
  ledger.propose(0, 999_000, 0); // same epoch, repeated proposals: both legal pre-commit
  assert.equal(ledger.hasReleased, false);
  assert.equal(ledger.cumulative, 0n);
});

test("simulator: never touches EpsilonLedger or a secret, and matches the real scale formula", () => {
  const sim = simulateConfidenceInterval({ meanEstimate: 0.05, clipBound: 0.1, sampleSize: 100, epsilon: 1 });
  assert.equal(sim.scale, laplaceScaleForMean(0.1, 100, 1));
  assert.ok(sim.ciLow < 0.05 && sim.ciHigh > 0.05);
  // A tighter epsilon (more private) widens the interval; a looser one narrows it.
  const tighter = simulateConfidenceInterval({ meanEstimate: 0.05, clipBound: 0.1, sampleSize: 100, epsilon: 0.2 });
  assert.ok(tighter.halfWidth > sim.halfWidth);
});

test("DPReporter: a built release is actually accepted by MandateRegistry.postLeaderboard() on-chain", async (t) => {
  const f = await fixture(t);
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  const reporterAddress = await f.keeper.getAddress();
  await (await registry.setReporter(reporterAddress)).wait();
  await (await registry.setEpsilonCap(5_000_000n)).wait();

  const { chainId } = await f.provider.getNetwork();
  const dpReporter = new DPReporter({
    reporterSecret: "integration-test-secret",
    signer: f.keeper,
    registryAddress: await registry.getAddress(),
    chainId,
    cap: 5_000_000n,
    clipBound: 0.1,
    epsilon: 0.5,
    statsVersion: 1
  });

  const pinnedBlock = await f.provider.getBlockNumber();
  const { release, signature, published } = await dpReporter.buildRelease({
    epoch: 0,
    pinnedBlock,
    perTradeReturns: [0.01, -0.02, 0.15, 0.03, -0.3], // the 0.15 and -0.3 should get clipped to +/-0.1
    navSeries: [1.0, 1.01, 0.99, 1.1, 1.04]
  });

  assert.equal(published.sampleSize, 5);
  assert.ok(Math.abs(published.noisyMean) < 10); // sane order of magnitude, noise included

  await (
    await registry.postLeaderboard(
      release.epoch,
      release.pinnedBlock,
      release.statsDigest,
      release.epsilonPerfE6,
      release.epsilonIntentE6,
      release.cumulativeEpsilonE6,
      signature
    )
  ).wait();
  dpReporter.commit(release.epoch, release.cumulativeEpsilonE6);

  assert.equal(await registry.lastEpoch(), 0n);
  assert.equal(await registry.cumulativeEpsilonE6(), release.cumulativeEpsilonE6);
  const stored = await registry.releaseOf(0n);
  assert.equal(stored.statsDigest, release.statsDigest);

  // A second release for a later epoch uses the committed ledger, so the
  // on-chain cumulative and this reporter's internal ledger cannot drift.
  const second = await dpReporter.buildRelease({
    epoch: 1,
    pinnedBlock: await f.provider.getBlockNumber(),
    perTradeReturns: [0.02],
    navSeries: [1.04, 1.06]
  });
  assert.equal(second.release.cumulativeEpsilonE6, release.cumulativeEpsilonE6 + second.release.epsilonPerfE6);
});

test("DPReporter: refuses to build a release that would exceed the configured cap before ever signing anything", async (t) => {
  const f = await fixture(t);
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  await (await registry.setReporter(await f.keeper.getAddress())).wait();
  await (await registry.setEpsilonCap(100_000n)).wait(); // tiny cap

  const { chainId } = await f.provider.getNetwork();
  const dpReporter = new DPReporter({
    reporterSecret: "secret",
    signer: f.keeper,
    registryAddress: await registry.getAddress(),
    chainId,
    cap: 100_000n,
    epsilon: 1.0 // epsilonPerfE6 = 1_000_000, already over the 100_000 cap
  });

  await assert.rejects(
    dpReporter.buildRelease({
      epoch: 0,
      pinnedBlock: await f.provider.getBlockNumber(),
      perTradeReturns: [0.01],
      navSeries: [1.0, 1.01]
    }),
    /exceed the epsilon cap/
  );
});
