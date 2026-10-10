// MandateRegistry.commitNoiseSeed(): the reporter pledges keccak256 of the
// seed its next release will be noised with, and postLeaderboard() binds the
// pledge to the epoch. The seed itself never goes on chain -- it would de-noise
// the release -- so the chain checks who pledged what and when, and an auditor
// holding the seed can check the rest with contracts/script/verify-noise.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { ZeroHash, keccak256 } from "ethers";
import { fixture } from "./fixture.mjs";
import { DPReporter } from "../../reporter/reporter.mjs";
import { clip, mean } from "../../reporter/stats.mjs";
import { verifyNoise } from "../script/verify-noise.mjs";

const RETURNS = [0.01, -0.02, 0.15, 0.03, -0.3];
const NAV = [1.0, 1.01, 0.99, 1.1, 1.04];

async function registryWithReporter(f) {
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  await (await registry.setReporter(await f.keeper.getAddress())).wait();
  await (await registry.setEpsilonCap(5_000_000n)).wait();
  const { chainId } = await f.provider.getNetwork();
  const reporter = new DPReporter({
    reporterSecret: "noise-commit-test-secret",
    signer: f.keeper,
    registryAddress: await registry.getAddress(),
    chainId,
    cap: 5_000_000n,
    clipBound: 0.1,
    epsilon: 0.5,
    statsVersion: 1
  });
  return { registry, asReporter: registry.connect(f.keeper), reporter };
}

async function post(registry, reporter, epoch, provider) {
  const built = await reporter.buildRelease({ epoch, pinnedBlock: await provider.getBlockNumber(), perTradeReturns: RETURNS, navSeries: NAV });
  const { release, signature } = built;
  const receipt = await (
    await registry.postLeaderboard(
      release.epoch, release.pinnedBlock, release.statsDigest, release.epsilonPerfE6, release.epsilonIntentE6, release.cumulativeEpsilonE6, signature
    )
  ).wait();
  reporter.commit(release.epoch, release.cumulativeEpsilonE6);
  return { ...built, receipt };
}

const mine = (provider) => provider.send("evm_mine", []);

test("commitNoiseSeed: reporter only, never zero, one pledge per window", async (t) => {
  const f = await fixture(t);
  const { registry, asReporter, reporter } = await registryWithReporter(f);
  const pledge = reporter.commitmentFor(0);

  await assert.rejects(registry.connect(f.outsider).commitNoiseSeed(pledge), /OnlyReporter|revert/);
  await assert.rejects(asReporter.commitNoiseSeed(ZeroHash), /ZeroCommitment|revert/);

  const receipt = await (await asReporter.commitNoiseSeed(pledge)).wait();
  const pending = await registry.pendingNoiseCommit();
  assert.equal(pending.commitment, pledge);
  assert.equal(Number(pending.committedAtBlock), receipt.blockNumber);
  assert.equal(pending.windowStartBlock, 0n);

  await assert.rejects(asReporter.commitNoiseSeed(reporter.commitmentFor(1)), /CommitAlreadyPending|revert/);
});

test("postLeaderboard binds the pending pledge to its epoch and clears it; a release without one binds nothing", async (t) => {
  const f = await fixture(t);
  const { registry, asReporter, reporter } = await registryWithReporter(f);

  await (await asReporter.commitNoiseSeed(reporter.commitmentFor(0))).wait();
  const first = await post(asReporter, reporter, 0, f.provider);
  const bound = await registry.noiseCommitOf(0);
  assert.equal(bound.commitment, reporter.commitmentFor(0));
  assert.ok(Number(bound.committedAtBlock) < first.receipt.blockNumber);
  assert.equal((await registry.pendingNoiseCommit()).commitment, ZeroHash);
  assert.equal(first.published.noiseCommit, bound.commitment);

  // Nothing pledged for epoch 1: the release goes through, and says so.
  await post(asReporter, reporter, 1, f.provider);
  assert.equal((await registry.noiseCommitOf(1)).commitment, ZeroHash);

  // The next pledge's window starts at the last release's pinned block.
  await (await asReporter.commitNoiseSeed(reporter.commitmentFor(2))).wait();
  assert.equal((await registry.pendingNoiseCommit()).windowStartBlock, (await registry.releaseOf(1)).pinnedBlock);
});

test("verify-noise: the public check reads the pledge and the digest; the audit opens the pledge with the exported seed", async (t) => {
  const f = await fixture(t);
  const { registry, asReporter, reporter } = await registryWithReporter(f);

  await (await asReporter.commitNoiseSeed(reporter.commitmentFor(0))).wait();
  await mine(f.provider); // the data window: the pledge precedes the pin
  const { release, published } = await post(asReporter, reporter, 0, f.provider);
  const onChain = { epoch: 0, ...(await registry.releaseOf(0)).toObject() };
  const noiseCommit = (await registry.noiseCommitOf(0)).toObject();

  // Public mode: no seed, only what the chain and the server show.
  const pub = verifyNoise({ release: onChain, noiseCommit, published: { epoch: 0, published } });
  assert.equal(pub.verdict, "verified", JSON.stringify(pub.checks));
  assert.ok(pub.checks.every((c) => c.ok));
  assert.equal(pub.audit, null);

  // A server that publishes a number the chain did not anchor is caught.
  const tampered = verifyNoise({ release: onChain, noiseCommit, published: { ...published, noisyMean: published.noisyMean + 1e-6 } });
  assert.equal(tampered.verdict, "mismatch");
  assert.equal(tampered.checks.find((c) => c.name === "published digest").ok, false);

  // Audit mode: the exported seed opens the pledge, and with the window's
  // inputs the whole release is reproduced. That also recovers the exact mean.
  const seed = reporter.exportSeedForAudit(0);
  assert.equal(keccak256(seed), noiseCommit.commitment);
  const audit = verifyNoise({ release: onChain, noiseCommit, published, seed, returns: RETURNS, nav: NAV });
  assert.equal(audit.verdict, "verified", JSON.stringify(audit.checks));
  assert.ok(audit.checks.find((c) => c.name === "recomputed digest").ok);
  assert.ok(Math.abs(audit.audit.exact.mean - mean(RETURNS.map((r) => clip(r, 0.1)))) < 1e-12);
  assert.equal(release.statsDigest, onChain.statsDigest);

  // The wrong seed does not open it.
  const wrong = verifyNoise({ release: onChain, noiseCommit, published, seed: reporter.exportSeedForAudit(1) });
  assert.equal(wrong.verdict, "mismatch");
  assert.equal(wrong.checks.find((c) => c.name === "seed opens pledge").ok, false);
});

test("verify-noise: a release without a pledge, or on a registry without pledges, is unverifiable; a pledge in the pinned block is late", async (t) => {
  const f = await fixture(t);
  const { registry, asReporter, reporter } = await registryWithReporter(f);

  const { published } = await post(asReporter, reporter, 0, f.provider);
  const onChain = { epoch: 0, ...(await registry.releaseOf(0)).toObject() };
  const none = verifyNoise({ release: onChain, noiseCommit: (await registry.noiseCommitOf(0)).toObject(), published });
  assert.equal(none.verdict, "unverifiable");
  assert.equal(verifyNoise({ release: onChain, noiseCommit: null }).verdict, "unverifiable");
  assert.equal(verifyNoise({ release: { ...onChain, statsDigest: ZeroHash }, noiseCommit: null }).verdict, "unverifiable");

  // Pledged and pinned in the same block: the pledge followed the data.
  await (await asReporter.commitNoiseSeed(reporter.commitmentFor(1))).wait();
  const second = await post(asReporter, reporter, 1, f.provider);
  const late = verifyNoise({
    release: { epoch: 1, ...(await registry.releaseOf(1)).toObject() },
    noiseCommit: (await registry.noiseCommitOf(1)).toObject(),
    published: { epoch: 1, published: second.published }
  });
  assert.equal(late.verdict, "late-pledge", JSON.stringify(late.checks));
  assert.ok(late.checks.filter((c) => c.hard).every((c) => c.ok));
});
