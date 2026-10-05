import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { intentDomain, intentTypes } from "../contracts/tools/batch.mjs";
import { DPReporter } from "../reporter/reporter.mjs";
import { RollingBudget } from "./live-gas.mjs";
import { createBatchDesk, createReporterDesk, gasGate, refuse, revertReason } from "./live-desks.mjs";

const A = (n) => `0x${String(n).padStart(40, "0")}`;
const allocator = new Wallet(`0x${"11".repeat(32)}`);
const stranger = new Wallet(`0x${"22".repeat(32)}`);
const VAULTS = [A(20), A(21)];
const domain = intentDomain(10143, A(50));
const timing = { genesis: 1000, epochDuration: 20, settlementWindow: 600 };
const rejects = (promise, pattern, status) =>
  assert.rejects(promise, (error) => {
    assert.match(error.message, pattern);
    if (status) assert.equal(error.httpStatus, status);
    return true;
  });

// A BatchAllocator that keeps the three ledgers the desk reads and records what
// it was asked to settle. `sinks(intent)` names the custom error an intent
// would revert a settlement with.
function fakeBatch({ escrow = 1_000_000_000n, sinks = () => null, gas = 400_000n } = {}) {
  const book = { escrow, used: new Set(), settled: new Set(), claimable: new Map(), sent: [], estimates: 0 };
  const check = (nets) => {
    for (const net of nets) for (const { intent } of net.intents) if (sinks(intent)) throw new Error(sinks(intent));
  };
  const settleEpoch = async (epoch, root, nets, overrides) => {
    book.sent.push({ epoch, root, nets, overrides });
    book.settled.add(Number(epoch));
    return { hash: `0xsettle${book.sent.length}` };
  };
  settleEpoch.estimateGas = async (_epoch, _root, nets) => {
    book.estimates += 1;
    check(nets);
    return gas;
  };
  settleEpoch.staticCall = async (_epoch, _root, nets) => check(nets);
  return {
    book,
    settleEpoch,
    settled: async (epoch) => book.settled.has(Number(epoch)),
    nonceUsed: async (_who, nonce) => book.used.has(String(nonce)),
    escrowOf: async () => book.escrow,
    claimableShares: async (digest) => book.claimable.get(digest) ?? 0n
  };
}

function desk(options = {}) {
  const world = { now: 1005, frozen: new Set(), allowed: true, resetting: false, wall: 0 };
  const batch = fakeBatch(options.batch);
  const api = createBatchDesk({
    domain,
    timing,
    vaults: VAULTS,
    batch,
    vaultState: async (vault) => (world.frozen.has(vault) ? 2n : 0n),
    chainTime: async () => world.now,
    send: async (make) => ({ ...(await make()), status: 1 }),
    admit: (estimate) => {
      if (!world.allowed) throw refuse("a settlement was sent moments ago", 429);
      return (estimate * 3n) / 2n;
    },
    resetting: () => world.resetting,
    clock: () => world.wall,
    limits: options.limits
  });
  return { api, batch, world };
}

let nonce = 0;
async function signed(extra = {}, signer = allocator) {
  const intent = {
    allocator: allocator.address, vault: VAULTS[0], amount: "100000000", minShares: "1", epoch: "0",
    nonce: String((nonce += 1)), deadline: String(1020 + 600), ...extra
  };
  return { intent, signature: await signer.signTypedData(domain, intentTypes, intent) };
}

test("a signed intent is queued once and shows in the status", async () => {
  const { api } = desk();
  const order = await signed();
  const first = await api.submitIntent(order);
  assert.equal(first.accepted, true);
  assert.equal((await api.submitIntent(order)).duplicate, true);
  const status = await api.status();
  assert.deepEqual(
    { chainTime: status.chainTime, currentEpoch: status.currentEpoch, currentEpochEnd: status.currentEpochEnd, genesis: status.genesis },
    { chainTime: 1005, currentEpoch: 0, currentEpochEnd: 1020, genesis: 1000 }
  );
  assert.equal(status.pending.length, 1);
  assert.equal(status.pending[0].digest, first.digest);
  assert.equal(status.pending[0].amount, "100000000");
});

test("an intent that could not settle is refused when it arrives", async () => {
  const { api, batch, world } = desk({ batch: { escrow: 150_000_000n } });
  await rejects(api.submitIntent({}), /missing intent or signature/, 400);
  await rejects(api.submitIntent(await signed({}, stranger)), /does not match intent\.allocator/, 400);
  await rejects(api.submitIntent({ ...(await signed()), signature: "0x1234" }), /malformed signature/, 400);
  await rejects(api.submitIntent(await signed({ vault: A(99) })), /not part of this demo/, 400);
  await rejects(api.submitIntent(await signed({ amount: "0" })), /greater than zero/, 400);
  await rejects(api.submitIntent(await signed({ epoch: "2" })), /too far ahead/, 400);
  await rejects(api.submitIntent(await signed({ deadline: "1019" })), /expires before its epoch/, 400);

  batch.book.used.add("777");
  await rejects(api.submitIntent(await signed({ nonce: "777" })), /already used/, 400);
  world.frozen.add(VAULTS[1]);
  await rejects(api.submitIntent(await signed({ vault: VAULTS[1] })), /not accepting allocations/, 400);

  // Escrow is drawn down in queue order: 150 covers one intent of 100, not two.
  await api.submitIntent(await signed({ nonce: "900" }));
  await rejects(api.submitIntent(await signed({ nonce: "901" })), /escrow has 50\.0 mUSDC free and this intent pays in 100\.0/, 400);
  await rejects(api.submitIntent(await signed({ nonce: "900", amount: "1" })), /nonce 900 is already queued/, 400);

  batch.book.settled.add(1);
  await rejects(api.submitIntent(await signed({ epoch: "1", amount: "1", deadline: "1700" })), /already settled/, 400);
  world.resetting = true;
  await rejects(api.submitIntent(await signed({ amount: "1" })), /being reset/, 409);
  assert.equal((await api.status()).pending.length, 1);
});

test("the queue is bounded per epoch", async () => {
  const { api } = desk({ limits: { maxPerEpoch: 2 } });
  await api.submitIntent(await signed());
  await api.submitIntent(await signed());
  await rejects(api.submitIntent(await signed()), /epoch 0 is full/, 429);
  assert.equal((await api.submitIntent(await signed({ epoch: "1", deadline: "1700" }))).accepted, true);
});

test("an epoch settles once it has ended, in one transaction, and leaves claims behind", async () => {
  const { api, batch, world } = desk();
  await rejects(api.settle(), /no pending intents/, 409);
  const a = await api.submitIntent(await signed({ vault: VAULTS[1] }));
  const b = await api.submitIntent(await signed({ vault: VAULTS[0] }));
  await rejects(api.settle(), /epoch 0 is not settleable yet — 15s left/, 409);
  assert.equal(batch.book.sent.length, 0);

  world.now = 1021;
  const [result, again] = await Promise.all([api.settle(), api.settle()]);
  assert.equal(again, result);
  assert.deepEqual(
    { epoch: result.epoch, intentCount: result.intentCount, vaultCount: result.vaultCount, dropped: result.dropped },
    { epoch: 0, intentCount: 2, vaultCount: 2, dropped: [] }
  );
  assert.equal(batch.book.sent.length, 1);
  const [sent] = batch.book.sent;
  assert.deepEqual(sent.nets.map((net) => net.vault), VAULTS);
  assert.equal(sent.overrides.gasLimit, 600_000n);
  assert.equal((await api.status()).pending.length, 0);

  // Proofs are handed out while the contract still owes the shares, and no longer.
  batch.book.claimable.set(a.digest, 5n).set(b.digest, 7n);
  world.wall = 10_000;
  const claims = await api.claimsFor(allocator.address.toLowerCase());
  assert.equal(claims.length, 2);
  assert.ok(Array.isArray(claims[0].proof));
  assert.deepEqual(await api.claimsFor(stranger.address), []);
  // The page polls: an answer is shared for a moment, until a transaction of the
  // allocator's lands or the moment has passed.
  batch.book.claimable.set(a.digest, 0n);
  assert.equal((await api.claimsFor(allocator.address)).length, 2);
  api.refresh();
  assert.equal((await api.claimsFor(allocator.address)).length, 1);
  batch.book.claimable.set(b.digest, 0n);
  world.wall = 20_000;
  assert.deepEqual(await api.claimsFor(allocator.address), []);
});

test("an intent that went stale after it was queued is left out, not allowed to sink the batch", async () => {
  const { api, batch, world } = desk();
  await api.submitIntent(await signed({ vault: VAULTS[0] }));
  const stale = await api.submitIntent(await signed({ vault: VAULTS[1] }));
  world.frozen.add(VAULTS[1]);
  world.now = 1021;
  const result = await api.settle();
  assert.equal(result.intentCount, 1);
  assert.deepEqual(result.dropped, [{ digest: stale.digest, reason: "the vault is not accepting allocations" }]);
  assert.deepEqual(batch.book.sent[0].nets.map((net) => net.vault), [VAULTS[0]]);
});

test("a batch that reverts is taken apart and settled without the intent that sinks it", async () => {
  const { api, batch, world } = desk({ batch: { sinks: (intent) => (intent.minShares === "999" ? "MinimumShares()" : null) } });
  await api.submitIntent(await signed());
  const greedy = await api.submitIntent(await signed({ minShares: "999" }));
  world.now = 1021;
  const result = await api.settle();
  assert.equal(result.intentCount, 1);
  assert.deepEqual(result.dropped, [{ digest: greedy.digest, reason: "MinimumShares()" }]);
  assert.equal(batch.book.sent.length, 1);
  assert.equal(batch.book.sent[0].nets[0].intents.length, 1);

  // ethers decodes a custom error it knows into `revert`; the reason is in plain words.
  const decoded = { revert: { name: "MinimumShares" }, shortMessage: "execution reverted (unknown custom error)" };
  assert.equal(revertReason(decoded, String), "the shares it would receive are below its minimum");
  assert.equal(revertReason({ revert: { name: "SomethingNew" } }, String), "SomethingNew");
  assert.equal(revertReason(new Error("timeout"), (error) => error.message), "timeout");

  // Nothing but intents that sink it: the epoch is dropped and nothing is sent.
  const other = desk({ batch: { sinks: () => "InvalidIntent()" } });
  await other.api.submitIntent(await signed());
  other.world.now = 1021;
  await rejects(other.api.settle(), /no intent left to settle: InvalidIntent\(\)/, 409);
  assert.equal(other.batch.book.sent.length, 0);
  assert.equal((await other.api.status()).pending.length, 0);
});

test("a settlement the server will not pay for, or one during a reset, is not sent", async () => {
  const busy = desk();
  await busy.api.submitIntent(await signed());
  busy.world.now = 1021;
  busy.world.allowed = false;
  await rejects(busy.api.settle(), /moments ago/, 429);
  busy.world.resetting = true;
  await rejects(busy.api.settle(), /being reset/, 409);
  assert.equal(busy.batch.book.sent.length, 0);
  // The intent is still queued for when the limit lifts.
  assert.equal((await busy.api.status()).pending.length, 1);
  busy.world.allowed = true;
  busy.world.resetting = false;
  assert.equal((await busy.api.settle()).intentCount, 1);
});

test("the gas gate caps one transaction, rate limits a kind and draws on a shared hourly allowance", () => {
  let now = 0;
  const budget = new RollingBudget(1_000_000n, 3_600_000, () => now);
  let tokens = 2;
  const bucket = { take: () => tokens-- > 0 };
  const settle = gasGate({ what: "a settlement", cap: 600_000, headroomPercent: 50, budget, bucket });
  const release = gasGate({ what: "a release", cap: 600_000, headroomPercent: 50, budget });
  const refused = (call, pattern, status) =>
    assert.throws(call, (error) => {
      assert.match(error.message, pattern);
      assert.equal(error.httpStatus, status);
      return true;
    });

  refused(() => settle(600_001n), /a settlement needs 600001 gas, above the demo cap of 600000/, 409);
  assert.equal(settle(200_000n), 300_000n);
  assert.equal(settle(500_000n), 600_000n); // headroom stops at the cap
  refused(() => settle(50_000n), /a settlement was sent moments ago/, 429);
  // A refusal spends nothing: 100,000 of the allowance are left, and a small release fits.
  refused(() => release(200_000n), /hour's gas allowance/, 429);
  assert.equal(release(60_000n), 90_000n);
  now = 3_600_001;
  assert.equal(release(200_000n), 300_000n);
});

test("an epoch nobody settled inside its window is forgotten", async () => {
  const { api, world } = desk();
  await api.submitIntent(await signed());
  world.now = 1020 + 601;
  assert.equal((await api.status()).pending.length, 0);
  await rejects(api.settle(), /no pending intents/, 409);
});

// --- reporter ---------------------------------------------------------------
function fakeRegistry(start = {}) {
  const state = { cumulative: 0n, cap: 50_000_000n, lastEpoch: 0n, hasReleased: false, lastPinnedBlock: 0n, ...start };
  const posted = [];
  const postLeaderboard = async (epoch, pinnedBlock, statsDigest, perf, intent, cumulative, signature, overrides) => {
    posted.push({ epoch, pinnedBlock, cumulative, signature, overrides });
    Object.assign(state, { cumulative, lastEpoch: epoch, hasReleased: true, lastPinnedBlock: pinnedBlock });
    return { hash: `0xrelease${posted.length}` };
  };
  postLeaderboard.estimateGas = async () => 190_000n;
  return {
    state,
    posted,
    postLeaderboard,
    cumulativeEpsilonE6: async () => state.cumulative,
    epsilonCap: async () => state.cap,
    lastEpoch: async () => state.lastEpoch,
    hasReleased: async () => state.hasReleased,
    lastPinnedBlock: async () => state.lastPinnedBlock
  };
}

function reporterDesk(start) {
  const world = { block: 500, wall: 1_000_000, nav: 1, resetting: false };
  const registry = fakeRegistry(start);
  const api = createReporterDesk({
    registry,
    address: A(60),
    reporter: new DPReporter({ reporterSecret: "test", signer: allocator, registryAddress: A(60), chainId: 10143, clipBound: 0.1, epsilon: 0.5 }),
    vaults: VAULTS,
    navOf: async (vault) => (vault === VAULTS[0] ? world.nav : 1),
    blockNumber: async () => world.block,
    send: async (make) => ({ ...(await make()), status: 1 }),
    admit: (estimate) => (estimate * 3n) / 2n,
    settings: { clipBound: 0.1, epsilon: 0.5 },
    resetting: () => world.resetting,
    clock: () => world.wall
  });
  const tick = async (nav) => {
    world.nav = nav;
    await api.sample();
  };
  return { api, registry, world, tick };
}

test("the reporter pools one return per vault per mark and releases once it has three", async () => {
  const { api, registry, tick } = reporterDesk();
  await tick(1); // the first mark has nothing to compare with
  assert.equal((await api.status()).sampleSize, 0);
  await tick(1.01);
  await rejects(api.publish(), /need at least 3 sampled returns to release, have 2/, 409);
  await tick(1.02);
  const before = await api.status();
  assert.deepEqual(
    { sampleSize: before.sampleSize, nextEpoch: before.nextEpoch, hasReleased: before.hasReleased, lastRelease: before.lastRelease },
    { sampleSize: 4, nextEpoch: 0, hasReleased: false, lastRelease: null }
  );

  const release = await api.publish();
  assert.equal(release.epoch, 0);
  assert.equal(release.pinnedBlock, 500);
  assert.equal(release.cumulativeEpsilonE6, "500000");
  assert.equal(release.published.sampleSize, 4);
  assert.equal(registry.posted.length, 1);
  assert.equal(registry.posted[0].overrides.gasLimit, 285_000n);
  const after = await api.status();
  assert.deepEqual(
    { sampleSize: after.sampleSize, nextEpoch: after.nextEpoch, hasReleased: after.hasReleased, cumulative: after.cumulativeEpsilonE6, cap: after.epsilonCap },
    { sampleSize: 0, nextEpoch: 1, hasReleased: true, cumulative: "500000", cap: "50000000" }
  );
  assert.equal(after.lastRelease.txHash, "0xrelease1");
});

test("releases are spaced out, advance the pinned block, and stop at the epsilon cap", async () => {
  const { api, registry, world, tick } = reporterDesk();
  for (const nav of [1, 1.01, 1.02, 1.03]) await tick(nav);
  await api.publish();
  for (const nav of [1.04, 1.05, 1.06]) await tick(nav);
  await rejects(api.publish(), /next one is due in 120s/, 429);
  world.wall += 121_000;
  await rejects(api.publish(), /pinned this block/, 409);
  world.block = 501;
  world.resetting = true;
  await rejects(api.publish(), /being reset/, 409);
  world.resetting = false;
  const second = await api.publish();
  assert.deepEqual({ epoch: second.epoch, cumulative: second.cumulativeEpsilonE6 }, { epoch: 1, cumulative: "1000000" });

  registry.state.cap = 1_200_000n;
  for (const nav of [1.07, 1.08, 1.09]) await tick(nav);
  world.wall += 121_000;
  world.block = 502;
  await rejects(api.publish(), /exceed the epsilon cap/, 409);
  assert.equal(registry.posted.length, 2);
  // A refused release spends neither samples nor the waiting time.
  assert.equal((await api.status()).sampleSize, 6);
  assert.equal((await api.status()).waitSeconds, 0);
});

test("a reporter that starts on a registry with history continues its ledger", async () => {
  const { api, registry, tick } = reporterDesk({ cumulative: 2_500_000n, lastEpoch: 4n, hasReleased: true, lastPinnedBlock: 400n });
  for (const nav of [1, 1.01, 1.02, 1.03]) await tick(nav);
  assert.equal((await api.status()).nextEpoch, 5);
  const release = await api.publish();
  assert.deepEqual({ epoch: release.epoch, cumulative: release.cumulativeEpsilonE6 }, { epoch: 5, cumulative: "3000000" });
  assert.equal(registry.posted[0].epoch, 5n);
});
