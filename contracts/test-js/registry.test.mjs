import assert from "node:assert/strict";
import test from "node:test";
import { ZeroHash, keccak256 } from "ethers";
import { fixture, BASE_LIMITS, DEFAULT_TRADE, termsHashOf } from "./fixture.mjs";

const RELEASE_TYPES = {
  LeaderboardRelease: [
    { name: "epoch", type: "uint256" },
    { name: "pinnedBlock", type: "uint256" },
    { name: "statsDigest", type: "bytes32" },
    { name: "epsilonPerfE6", type: "uint256" },
    { name: "epsilonIntentE6", type: "uint256" },
    { name: "cumulativeEpsilonE6", type: "uint256" }
  ]
};

async function deployRegistry(f) {
  return f.deploy("MandateRegistry", "MandateRegistry");
}

async function releaseDomain(registry, provider) {
  const { chainId } = await provider.getNetwork();
  return { name: "MandateRegistry", version: "1", chainId, verifyingContract: await registry.getAddress() };
}

test("registerAgent catalogs a locked mandate and rejects a second registration", async (t) => {
  const fees = { performanceFeeBps: 1000, managementFeeBps: 200 };
  const f = await fixture(t, {}, { fees });
  const registry = await deployRegistry(f);

  const tx = await registry.registerAgent(
    f.vaultAddress,
    f.adapterAddress,
    BASE_LIMITS,
    { performanceFeeBps: 1000, managementFeeBps: 200 },
    ZeroHash
  );
  await tx.wait();

  const entry = await registry.agentOf(f.vaultAddress);
  assert.equal(entry.guard, await f.guard.getAddress());
  assert.equal(entry.adapter, f.adapterAddress);
  assert.equal(entry.termsHash, termsHashOf(BASE_LIMITS, DEFAULT_TRADE, fees));
  assert.notEqual(entry.registeredAt, 0n);

  await assert.rejects(
    registry.registerAgent(
      f.vaultAddress,
      f.adapterAddress,
      BASE_LIMITS,
      { performanceFeeBps: 0, managementFeeBps: 0 },
      ZeroHash
    ),
    /AlreadyRegistered|revert/
  );
});

test("registerAgent refuses a vault whose terms are not locked yet", async (t) => {
  const f = await fixture(t, {}, { lockTerms: false });
  const registry = await deployRegistry(f);

  await assert.rejects(
    registry.registerAgent(
      f.vaultAddress,
      f.adapterAddress,
      BASE_LIMITS,
      { performanceFeeBps: 0, managementFeeBps: 0 },
      ZeroHash
    ),
    /TermsNotLocked|revert/
  );
});

test("registerAgent refuses limits that do not match the vault's real termsHash", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);

  await assert.rejects(
    registry.registerAgent(
      f.vaultAddress,
      f.adapterAddress,
      { ...BASE_LIMITS, maxLeverageX100: 999 },
      { performanceFeeBps: 0, managementFeeBps: 0 },
      ZeroHash
    ),
    /TermsMismatch|revert/
  );
});

test("registerAgent refuses an adapter the vault's guard has not allowed", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);
  const rogueAdapter = await f.deploy("MockVenueAdapter", "MockVenueAdapter", [await f.venue.getAddress()]);

  await assert.rejects(
    registry.registerAgent(
      f.vaultAddress,
      await rogueAdapter.getAddress(),
      BASE_LIMITS,
      { performanceFeeBps: 0, managementFeeBps: 0 },
      ZeroHash
    ),
    /AdapterNotAllowed|revert/
  );
});

// 2026-10-04 security review: an earlier version took `guard` as a parameter
// and only checked that it was internally self-consistent, never that it was
// actually the vault's own guard. That let anyone deploy a fake guard that
// answers every check with "yes" and permanently squat a real vault's
// one-time registry slot with fabricated terms. guard is now read from
// vault.riskGuard() directly, so there is no parameter left to spoof.
test("registerAgent reads the real guard off the vault and cannot be pointed at a fake one", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);

  const tx = await registry.registerAgent(
    f.vaultAddress,
    f.adapterAddress,
    BASE_LIMITS,
    { performanceFeeBps: 0, managementFeeBps: 0 },
    ZeroHash
  );
  await tx.wait();

  const entry = await registry.agentOf(f.vaultAddress);
  // The stored guard is whatever vault.riskGuard() actually returns -- there
  // was never an opportunity for a caller to supply a different address.
  assert.equal(entry.guard, await f.guard.getAddress());
});

test("registerAgent is restricted to the vault's guard owner, not permissionless", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);

  await assert.rejects(
    registry
      .connect(f.outsider)
      .registerAgent(
        f.vaultAddress,
        f.adapterAddress,
        BASE_LIMITS,
        { performanceFeeBps: 5000, managementFeeBps: 5000 },
        ZeroHash
      ),
    /OnlyGuardOwner|revert/
  );
});

test("postLeaderboard accepts a signed release from the configured reporter and anchors the epsilon ledger", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);
  await (await registry.setReporter(await f.keeper.getAddress())).wait();

  const domain = await releaseDomain(registry, f.provider);
  const pinnedBlock = await f.provider.getBlockNumber();
  const release = {
    epoch: 0n,
    pinnedBlock: BigInt(pinnedBlock),
    statsDigest: keccak256("0x1234"),
    epsilonPerfE6: 500_000n,
    epsilonIntentE6: 0n,
    cumulativeEpsilonE6: 500_000n
  };
  const signature = await f.keeper.signTypedData(domain, RELEASE_TYPES, release);

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

  assert.equal(await registry.lastEpoch(), 0n);
  assert.equal(await registry.cumulativeEpsilonE6(), 500_000n);
  const stored = await registry.releaseOf(0n);
  assert.equal(stored.statsDigest, release.statsDigest);
});

test("postLeaderboard rejects a signature from anyone but the configured reporter", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);
  await (await registry.setReporter(await f.keeper.getAddress())).wait();

  const domain = await releaseDomain(registry, f.provider);
  const release = {
    epoch: 0n,
    pinnedBlock: BigInt(await f.provider.getBlockNumber()),
    statsDigest: keccak256("0x01"),
    epsilonPerfE6: 100_000n,
    epsilonIntentE6: 0n,
    cumulativeEpsilonE6: 100_000n
  };
  // Signed by outsider, not the configured reporter.
  const signature = await f.outsider.signTypedData(domain, RELEASE_TYPES, release);

  await assert.rejects(
    registry.postLeaderboard(
      release.epoch,
      release.pinnedBlock,
      release.statsDigest,
      release.epsilonPerfE6,
      release.epsilonIntentE6,
      release.cumulativeEpsilonE6,
      signature
    ),
    /OnlyReporter|revert/
  );
});

test("postLeaderboard cannot replace a released epoch and cannot stand still on pinnedBlock", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);
  await (await registry.setReporter(await f.keeper.getAddress())).wait();
  const domain = await releaseDomain(registry, f.provider);

  async function post(overrides) {
    const base = {
      epoch: 0n,
      pinnedBlock: BigInt(await f.provider.getBlockNumber()),
      statsDigest: keccak256("0x02"),
      epsilonPerfE6: 100_000n,
      epsilonIntentE6: 0n,
      cumulativeEpsilonE6: 100_000n,
      ...overrides
    };
    const signature = await f.keeper.signTypedData(domain, RELEASE_TYPES, base);
    return registry.postLeaderboard(
      base.epoch,
      base.pinnedBlock,
      base.statsDigest,
      base.epsilonPerfE6,
      base.epsilonIntentE6,
      base.cumulativeEpsilonE6,
      signature
    );
  }

  await (await post({})).wait();

  // Same epoch again, even with a later pinnedBlock and consistent epsilon math.
  await assert.rejects(
    post({ pinnedBlock: BigInt(await f.provider.getBlockNumber()) + 10n }),
    /EpochNotIncreasing|revert/
  );

  // A later epoch but a pinnedBlock that does not move forward.
  const stalePinned = await f.provider.getBlockNumber();
  await assert.rejects(
    post({
      epoch: 1n,
      pinnedBlock: BigInt(stalePinned) - 1n > 0n ? BigInt(stalePinned) - 1n : 0n,
      cumulativeEpsilonE6: 200_000n
    }),
    /PinnedBlockNotIncreasing|revert/
  );
});

test("postLeaderboard refuses a pinnedBlock that has not happened yet", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);
  await (await registry.setReporter(await f.keeper.getAddress())).wait();
  const domain = await releaseDomain(registry, f.provider);

  const release = {
    epoch: 0n,
    pinnedBlock: BigInt(await f.provider.getBlockNumber()) + 1_000n,
    statsDigest: keccak256("0x03"),
    epsilonPerfE6: 100_000n,
    epsilonIntentE6: 0n,
    cumulativeEpsilonE6: 100_000n
  };
  const signature = await f.keeper.signTypedData(domain, RELEASE_TYPES, release);

  await assert.rejects(
    registry.postLeaderboard(
      release.epoch,
      release.pinnedBlock,
      release.statsDigest,
      release.epsilonPerfE6,
      release.epsilonIntentE6,
      release.cumulativeEpsilonE6,
      signature
    ),
    /PinnedBlockInFuture|revert/
  );
});

test("postLeaderboard rejects epsilon arithmetic that does not add up, and refuses to exceed a configured cap", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);
  await (await registry.setReporter(await f.keeper.getAddress())).wait();
  await (await registry.setEpsilonCap(150_000n)).wait();
  const domain = await releaseDomain(registry, f.provider);

  async function sign(release) {
    return f.keeper.signTypedData(domain, RELEASE_TYPES, release);
  }

  const badMath = {
    epoch: 0n,
    pinnedBlock: BigInt(await f.provider.getBlockNumber()),
    statsDigest: keccak256("0x04"),
    epsilonPerfE6: 100_000n,
    epsilonIntentE6: 0n,
    cumulativeEpsilonE6: 999_999n // does not equal 0 + 100_000 + 0
  };
  await assert.rejects(
    registry.postLeaderboard(
      badMath.epoch,
      badMath.pinnedBlock,
      badMath.statsDigest,
      badMath.epsilonPerfE6,
      badMath.epsilonIntentE6,
      badMath.cumulativeEpsilonE6,
      await sign(badMath)
    ),
    /EpsilonAccountingMismatch|revert/
  );

  const overCap = {
    epoch: 0n,
    pinnedBlock: BigInt(await f.provider.getBlockNumber()),
    statsDigest: keccak256("0x05"),
    epsilonPerfE6: 200_000n,
    epsilonIntentE6: 0n,
    cumulativeEpsilonE6: 200_000n // over the 150_000 cap
  };
  await assert.rejects(
    registry.postLeaderboard(
      overCap.epoch,
      overCap.pinnedBlock,
      overCap.statsDigest,
      overCap.epsilonPerfE6,
      overCap.epsilonIntentE6,
      overCap.cumulativeEpsilonE6,
      await sign(overCap)
    ),
    /EpsilonCapExceeded|revert/
  );
});

test("postLeaderboard refuses to run before a reporter is configured, and admin setters are owner-only", async (t) => {
  const f = await fixture(t);
  const registry = await deployRegistry(f);
  const domain = await releaseDomain(registry, f.provider);
  const release = {
    epoch: 0n,
    pinnedBlock: BigInt(await f.provider.getBlockNumber()),
    statsDigest: keccak256("0x06"),
    epsilonPerfE6: 1n,
    epsilonIntentE6: 0n,
    cumulativeEpsilonE6: 1n
  };
  const signature = await f.keeper.signTypedData(domain, RELEASE_TYPES, release);

  await assert.rejects(
    registry.postLeaderboard(
      release.epoch,
      release.pinnedBlock,
      release.statsDigest,
      release.epsilonPerfE6,
      release.epsilonIntentE6,
      release.cumulativeEpsilonE6,
      signature
    ),
    /ReporterNotConfigured|revert/
  );

  await assert.rejects(
    registry.connect(f.outsider).setReporter(await f.keeper.getAddress()),
    /OwnableUnauthorizedAccount|revert/
  );
  await assert.rejects(registry.connect(f.outsider).setEpsilonCap(1n), /OwnableUnauthorizedAccount|revert/);
});
