// The two off-chain roles a live deployment needs beside its contracts: the
// batcher that nets signed AllocationIntents into BatchAllocator.settleEpoch(),
// and the reporter that posts a DP release to MandateRegistry. web/chain.mjs
// plays both for the in-process chain, where one visitor owns the whole book
// and a reverted transaction costs nothing.
//
// On a public server neither holds. Every visitor shares the one allocator
// account, settleEpoch() reverts as a whole when a single intent is stale, and
// a revert that reaches the chain is billed to the deployer. So an intent is
// checked against the chain when it arrives and again before it is settled, a
// batch that still fails is taken apart to find the intents that sink it, and
// nothing is sent that did not pass a gas estimate first.
//
// No chain access of its own: web/live.mjs hands in the contracts, the clock
// and the queue its own transactions go through, and tests hand in fakes.
import { ZeroHash, formatUnits, verifyTypedData } from "ethers";
import { hashIntent, intentTypes } from "../contracts/tools/batch.mjs";
import { gasLimitFor } from "./live-gas.mjs";
import { epochAt, epochEnd, normaliseIntent, planSettlement, settlementDeadline, settleableEpochs } from "./intents.mjs";

// What the page sees as an error. `httpStatus` picks the response code: 400 for
// a request that can never succeed, 409 for one that may once the chain has
// moved on, 429 for one that is merely too soon.
export const refuse = (message, httpStatus = 400) => Object.assign(new Error(message), { httpStatus });

// What a contract said when it refused. ethers decodes a custom error into
// `revert` and leaves "unknown custom error" in the message it is asked for.
const REVERTS = {
  MinimumShares: "the shares it would receive are below its minimum",
  InsufficientEscrow: "its escrow no longer covers it",
  NonceUnavailable: "its nonce is already used",
  InvalidIntent: "it has expired, or names another epoch or vault",
  InvalidSignature: "its signature is not valid",
  EpochAlreadySettled: "the epoch is already settled",
  EpsilonCapExceeded: "the privacy budget of this registry is spent",
  EpochNotIncreasing: "a release for this epoch is already posted",
  PinnedBlockNotIncreasing: "the last release pinned this block or a later one"
};
export const revertReason = (error, describe) => {
  const name = error?.revert?.name;
  return name ? (REVERTS[name] ?? name) : describe(error);
};

// What the deployer will pay for a settlement or a release: the gas limit to
// sign with, or the refusal. Monad bills the signed limit and anybody can press
// the button, so one transaction is capped, each kind is rate limited, and all
// of them draw on one rolling allowance of gas.
export function gasGate({ what, cap, headroomPercent, budget, bucket = null }) {
  return (estimate) => {
    if (BigInt(estimate) > BigInt(cap)) throw refuse(`${what} needs ${estimate} gas, above the demo cap of ${cap}`, 409);
    const limit = gasLimitFor(estimate, headroomPercent, cap);
    if (budget.left() < limit) throw refuse("the demo has spent this hour's gas allowance for settlements and releases; try again later", 429);
    if (bucket && !bucket.take()) throw refuse(`${what} was sent moments ago; try again in a minute`, 429);
    budget.spend(limit);
    return limit;
  };
}

export const BATCH_LIMITS = {
  // settleEpoch() takes 128 intents; the demo stops far short of that so one
  // settlement stays inside the gas the server is willing to sign for.
  maxPerEpoch: 16,
  maxPending: 64,
  // An intent the page signs for the next epoch arrives one epoch early.
  maxEpochsAhead: 1,
  // A settlement lands a block or two after it was estimated: an intent whose
  // deadline falls inside that gap would revert the batch it is in.
  deadlineMarginSeconds: 5,
  maxClaims: 256,
  // Every open page asks for its claims every few seconds.
  claimsShareMs: 2000
};

export function createBatchDesk({
  domain, timing, vaults, batch, vaultState, chainTime, send, admit, describe = (e) => e?.message ?? String(e),
  resetting = () => false, limits = {}, clock = Date.now, log = () => {}
}) {
  const rules = { ...BATCH_LIMITS, ...limits };
  const known = new Set(vaults.map((v) => v.toLowerCase()));
  let pending = []; // { intent, signature, digest }
  const claims = new Map(); // digest -> { intent, proof }
  let settling = null;
  const answered = new Map(); // allocator -> { at, value }

  const sameAllocator = (a, b) => a.intent.allocator === b.intent.allocator;

  function dropExpired(now) {
    pending = pending.filter((p) => now <= settlementDeadline(timing, p.intent.epoch));
  }

  // Why this intent cannot be settled right now, or null. `others` are the
  // intents ahead of it in the same queue: escrow is drawn down in order and a
  // nonce is spent by the first intent that carries it.
  async function objection(entry, others, now) {
    const { intent } = entry;
    const epoch = Number(intent.epoch);
    if (now > settlementDeadline(timing, epoch)) return `epoch ${epoch} is past its settlement window`;
    if (Number(intent.deadline) < epochEnd(timing, epoch)) return "the intent expires before its epoch can be settled";
    if (Number(intent.deadline) < now + rules.deadlineMarginSeconds) return "the intent has expired";
    const mine = others.filter((p) => sameAllocator(p, entry));
    if (mine.some((p) => p.intent.nonce === intent.nonce)) return `nonce ${intent.nonce} is already queued`;
    const [settled, used, escrow, state] = await Promise.all([
      batch.settled(epoch), batch.nonceUsed(intent.allocator, intent.nonce), batch.escrowOf(intent.allocator), vaultState(intent.vault)
    ]);
    if (settled) return `epoch ${epoch} is already settled`;
    if (used) return `nonce ${intent.nonce} is already used`;
    if (Number(state) !== 0) return "the vault is not accepting allocations";
    const queued = mine.reduce((sum, p) => sum + BigInt(p.intent.amount), 0n);
    const free = BigInt(escrow) > queued ? BigInt(escrow) - queued : 0n;
    if (free < BigInt(intent.amount)) {
      return `escrow has ${formatUnits(free, 6)} mUSDC free and this intent pays in ${formatUnits(intent.amount, 6)}; deposit more first`;
    }
    return null;
  }

  async function status() {
    const now = await chainTime();
    dropExpired(now);
    const currentEpoch = epochAt(timing, now);
    return {
      chainTime: now,
      genesis: timing.genesis,
      epochDuration: timing.epochDuration,
      settlementWindow: timing.settlementWindow,
      currentEpoch,
      currentEpochEnd: epochEnd(timing, currentEpoch),
      pending: pending.map(({ intent, digest }) => ({ ...intent, digest }))
    };
  }

  async function submitIntent({ intent: raw, signature } = {}) {
    if (!raw || typeof signature !== "string") throw refuse("missing intent or signature");
    let intent;
    try {
      intent = normaliseIntent(raw);
    } catch (error) {
      throw refuse(error.message);
    }
    let signer;
    try {
      signer = verifyTypedData(domain, intentTypes, intent, signature);
    } catch {
      throw refuse("malformed signature");
    }
    if (signer !== intent.allocator) throw refuse("signature does not match intent.allocator");
    if (!known.has(intent.vault.toLowerCase())) throw refuse("vault is not part of this demo");
    const digest = hashIntent(domain, intent);
    if (pending.some((p) => p.digest === digest)) return { accepted: true, digest, duplicate: true };
    if (resetting()) throw refuse("the demo is being reset; try again in a few seconds", 409);

    const now = await chainTime();
    dropExpired(now);
    const epoch = Number(intent.epoch);
    if (epoch > epochAt(timing, now) + rules.maxEpochsAhead) throw refuse(`epoch ${epoch} is too far ahead`);
    if (pending.length >= rules.maxPending) throw refuse("the intent queue is full; settle an epoch first", 429);
    if (pending.filter((p) => Number(p.intent.epoch) === epoch).length >= rules.maxPerEpoch) {
      throw refuse(`epoch ${epoch} is full; sign for the next one`, 429);
    }
    const entry = { intent, signature, digest };
    const why = await objection(entry, pending, now);
    if (why) throw refuse(why);
    // The checks above waited on the chain: the same intent may have arrived twice meanwhile.
    if (pending.some((p) => p.digest === digest)) return { accepted: true, digest, duplicate: true };
    pending.push(entry);
    return { accepted: true, digest };
  }

  async function settleNow() {
    const now = await chainTime();
    dropExpired(now);
    const [epoch] = settleableEpochs(timing, pending, now);
    if (epoch === undefined) {
      const next = pending.map((p) => Number(p.intent.epoch)).sort((a, b) => a - b)[0];
      if (next === undefined) throw refuse("no pending intents to settle", 409);
      throw refuse(`epoch ${next} is not settleable yet — ${Math.max(0, epochEnd(timing, next) - now)}s left before it ends`, 409);
    }

    // An epoch settles once: whatever is not in this batch is lost to it, so
    // every intent is looked at again and the reason it stayed out is kept.
    const dropped = [];
    let batchOf = [];
    for (const entry of pending.filter((p) => Number(p.intent.epoch) === epoch)) {
      const why = await objection(entry, batchOf, now);
      if (why) dropped.push({ digest: entry.digest, reason: why });
      else batchOf.push(entry);
    }
    const forget = () => {
      pending = pending.filter((p) => Number(p.intent.epoch) !== epoch);
    };
    if (batchOf.length === 0) {
      forget();
      throw refuse(`epoch ${epoch} has no intent left to settle: ${dropped[0].reason}`, 409);
    }

    const estimate = async (entries) => {
      const plan = planSettlement(domain, entries);
      return { plan, gas: await batch.settleEpoch.estimateGas(epoch, plan.root, plan.nets) };
    };
    let attempt;
    try {
      attempt = await estimate(batchOf);
    } catch (error) {
      // The batch reverts as a whole. Settle each intent alone, against the
      // chain as it is now, to find the ones that sink it (a minimum the vault's
      // price has moved past, mostly), and try once more without them.
      const kept = [];
      for (const entry of batchOf) {
        const solo = planSettlement(domain, [entry]);
        try {
          await batch.settleEpoch.staticCall(epoch, solo.root, solo.nets);
          kept.push(entry);
        } catch (alone) {
          dropped.push({ digest: entry.digest, reason: revertReason(alone, describe) });
        }
      }
      if (kept.length === batchOf.length) throw refuse(`settlement would revert: ${revertReason(error, describe)}`, 409);
      if (kept.length === 0) {
        forget();
        throw refuse(`epoch ${epoch} has no intent left to settle: ${dropped.at(-1).reason}`, 409);
      }
      batchOf = kept;
      try {
        attempt = await estimate(batchOf);
      } catch (again) {
        throw refuse(`settlement would revert: ${revertReason(again, describe)}`, 409);
      }
    }

    const limit = admit(attempt.gas); // throws the refusal: over the cap, too soon, allowance spent
    const { plan } = attempt;
    const receipt = await send(() => batch.settleEpoch(epoch, plan.root, plan.nets, { gasLimit: limit }));
    if (receipt?.status === 0) throw refuse(`settlement of epoch ${epoch} reverted on chain`, 409);

    for (const claim of plan.claims) {
      claims.set(claim.digest, { intent: claim.intent, proof: claim.proof });
      if (claims.size > rules.maxClaims) claims.delete(claims.keys().next().value);
    }
    answered.clear();
    forget();
    log(`[batch] epoch ${epoch}: ${batchOf.length} intents into ${plan.nets.length} vaults, ${dropped.length} left out -> ${receipt.hash}`);
    return { epoch, intentCount: batchOf.length, vaultCount: plan.nets.length, txHash: receipt.hash, dropped };
  }

  // Two clicks on "settle" are one settlement.
  function settle() {
    if (resetting()) return Promise.reject(refuse("the demo is being reset; try again in a few seconds", 409));
    settling ??= settleNow().finally(() => {
      settling = null;
    });
    return settling;
  }

  // claimShares() leaves a proof in the map after it paid out; the contract's
  // own ledger says which ones are still worth relaying.
  async function claimsFor(address) {
    const needle = String(address ?? "").toLowerCase();
    const last = answered.get(needle);
    if (last && clock() - last.at < rules.claimsShareMs) return last.value;
    const mine = [...claims].filter(([, { intent }]) => intent.allocator.toLowerCase() === needle);
    const left = await Promise.all(mine.map(([digest]) => batch.claimableShares(digest)));
    const value = mine.flatMap(([digest, claim], i) => {
      if (BigInt(left[i]) > 0n) return [claim];
      claims.delete(digest);
      return [];
    });
    if (answered.size > 64) answered.clear();
    answered.set(needle, { at: clock(), value });
    return value;
  }

  // A transaction of the allocator's just landed, a claim perhaps: the answers
  // held for the page's polling are from before it.
  const refresh = () => answered.clear();

  return { status, submitIntent, settle, claimsFor, refresh };
}

export const REPORTER_LIMITS = {
  minSamples: 3,
  maxSamples: 2000,
  // Every release spends epsilon from a capped budget and gas from the
  // deployer, and anybody can press the button.
  minIntervalSeconds: 120,
  statusShareMs: 2000
};

export function createReporterDesk({
  registry, address, reporter, vaults, navOf, blockNumber, send, admit, settings,
  describe = (e) => e?.message ?? String(e), resetting = () => false, limits = {}, clock = Date.now, log = () => {}
}) {
  const rules = { ...REPORTER_LIMITS, ...limits };
  let pooledReturns = [];
  let marketNavSeries = [];
  const lastNav = new Map();
  let lastRelease = null;
  let lastReleaseAt = 0;
  let publishing = null;
  let shared = { at: 0, value: null };

  // Seed pledges (MandateRegistry.commitNoiseSeed): keccak256 of the seed the
  // next release will be noised with, recorded before the window's data. A
  // registry deployed before the call existed answers the probe with empty
  // data, so the desk asks once and, when the answer is no, releases as before.
  let pledges = null; // true, false, or null until the registry has answered
  async function pledging() {
    if (pledges === null) {
      if (typeof registry.commitNoiseSeed !== "function" || typeof registry.pendingNoiseCommit !== "function") {
        pledges = false;
      } else {
        try {
          await registry.pendingNoiseCommit();
          pledges = true;
        } catch (error) {
          if (error?.code !== "BAD_DATA" && error?.code !== "CALL_EXCEPTION") throw error;
          pledges = false;
        }
      }
    }
    return pledges;
  }
  async function sendPledge(epoch, commitment = reporter.commitmentFor(epoch)) {
    let gas;
    try {
      gas = await registry.commitNoiseSeed.estimateGas(commitment);
    } catch (error) {
      throw refuse(`the registry would refuse the noise pledge: ${revertReason(error, describe)}`, 409);
    }
    const limit = admit(gas);
    const receipt = await send(() => registry.commitNoiseSeed(commitment, { gasLimit: limit }));
    if (receipt?.status === 0) throw refuse("the noise pledge reverted on chain", 409);
    log(`[reporter] epoch ${epoch}: noise seed pledged ${commitment} -> ${receipt.hash}`);
    return { commitment, committedAtBlock: receipt.blockNumber ?? null, matches: true };
  }
  // The pledge an epoch's release answers to: the one pending on the registry,
  // or one sent now. The registry takes one pledge per window, so a pending
  // one this reporter cannot open (a restart drew a new secret, or another
  // reporter made it) stays, the release is bound to it all the same, and
  // `matches` says that an audit with this reporter's seed would fail.
  async function pledgeFor(epoch) {
    const ours = reporter.commitmentFor(epoch);
    const pending = await registry.pendingNoiseCommit();
    if (pending.commitment === ZeroHash) return sendPledge(epoch, ours);
    const matches = pending.commitment === ours;
    if (!matches) log(`[reporter] epoch ${epoch}: the pending noise pledge ${pending.commitment} is not this reporter's`);
    return { commitment: pending.commitment, committedAtBlock: Number(pending.committedAtBlock), matches };
  }

  // The registry is the ledger of record. A server that restarts, or adopts a
  // registry somebody already posted to, starts from what the chain says rather
  // than from zero, or its first release would carry the wrong running total.
  async function ledger() {
    const [cumulative, cap, lastEpoch, hasReleased, lastPinnedBlock] = await Promise.all([
      registry.cumulativeEpsilonE6(), registry.epsilonCap(), registry.lastEpoch(), registry.hasReleased(), registry.lastPinnedBlock()
    ]);
    Object.assign(reporter.ledger, { cumulative, cap, lastEpoch, hasReleased });
    return { cumulative, cap, lastEpoch, hasReleased, lastPinnedBlock };
  }
  // One step return per vault per mark, pooled, and the market-wide NAV the
  // drawdown is measured on. Public numbers: MandateRiskGuard.quote() is a view.
  async function sample() {
    const navs = (await Promise.all(vaults.map((v) => navOf(v).catch(() => null)))).map((nav, i) => [vaults[i], nav]);
    const seen = [];
    for (const [vault, nav] of navs) {
      if (nav === null || !Number.isFinite(nav)) continue;
      seen.push(nav);
      const previous = lastNav.get(vault);
      if (previous !== undefined && previous !== 0) pooledReturns.push(nav / previous - 1);
      lastNav.set(vault, nav);
    }
    if (pooledReturns.length > rules.maxSamples) pooledReturns = pooledReturns.slice(-rules.maxSamples);
    if (seen.length > 0) {
      marketNavSeries.push(seen.reduce((a, b) => a + b, 0) / seen.length);
      if (marketNavSeries.length > rules.maxSamples) marketNavSeries = marketNavSeries.slice(-rules.maxSamples);
    }
  }

  const waitSeconds = () => Math.max(0, Math.ceil((lastReleaseAt + rules.minIntervalSeconds * 1000 - clock()) / 1000));

  async function status() {
    if (!shared.value || clock() - shared.at >= rules.statusShareMs) {
      const { cumulative, cap, lastEpoch, hasReleased } = await ledger();
      shared = { at: clock(), value: { cumulative, cap, lastEpoch, hasReleased } };
    }
    const { cumulative, cap, lastEpoch, hasReleased } = shared.value;
    return {
      address,
      cumulativeEpsilonE6: cumulative.toString(),
      epsilonCap: cap.toString(),
      lastEpoch: lastEpoch.toString(),
      hasReleased,
      nextEpoch: hasReleased ? Number(lastEpoch) + 1 : 0,
      sampleSize: pooledReturns.length,
      clipBound: settings.clipBound,
      epsilon: settings.epsilon,
      minIntervalSeconds: rules.minIntervalSeconds,
      waitSeconds: waitSeconds(),
      noisePledges: await pledging().catch(() => false),
      lastRelease
    };
  }

  async function publishNow() {
    if (pooledReturns.length < rules.minSamples) {
      throw refuse(`need at least ${rules.minSamples} sampled returns to release, have ${pooledReturns.length} -- wait for a few more price ticks`, 409);
    }
    if (waitSeconds() > 0) throw refuse(`a release was posted moments ago; the next one is due in ${waitSeconds()}s`, 429);
    const { lastEpoch, hasReleased, lastPinnedBlock } = await ledger();
    const epoch = hasReleased ? Number(lastEpoch) + 1 : 0;
    // The pledge goes in before the block the data is pinned at. Normally it
    // has been pending since the previous release; the first release of a
    // fresh reporter pledges here, and the verifier shows how late that was.
    const pledge = (await pledging()) ? await pledgeFor(epoch) : null;
    const pinnedBlock = await blockNumber();
    if (hasReleased && BigInt(pinnedBlock) <= BigInt(lastPinnedBlock)) throw refuse("the last release pinned this block; try again in a moment", 409);

    const samples = pooledReturns.slice();
    let built;
    try {
      built = await reporter.buildRelease({
        epoch, pinnedBlock, perTradeReturns: samples, navSeries: marketNavSeries.length >= 2 ? marketNavSeries.slice() : [1, 1]
      });
    } catch (error) {
      throw refuse(error.message, 409); // the epsilon cap, mostly
    }
    const { release, signature, published } = built;
    const args = [
      release.epoch, release.pinnedBlock, release.statsDigest, release.epsilonPerfE6, release.epsilonIntentE6, release.cumulativeEpsilonE6, signature
    ];
    let gas;
    try {
      gas = await registry.postLeaderboard.estimateGas(...args);
    } catch (error) {
      throw refuse(`the registry would refuse this release: ${revertReason(error, describe)}`, 409);
    }
    const limit = admit(gas);
    // The interval counts from the attempt, so a release that is slow to land
    // is not followed by a second one; an attempt that never left gives it back.
    const before = lastReleaseAt;
    lastReleaseAt = clock();
    let receipt;
    try {
      receipt = await send(() => registry.postLeaderboard(...args, { gasLimit: limit }));
    } catch (error) {
      lastReleaseAt = before;
      throw error;
    }
    if (receipt?.status === 0) throw refuse("the release reverted on chain", 409);
    reporter.commit(release.epoch, release.cumulativeEpsilonE6);
    shared = { at: 0, value: null };

    lastRelease = {
      epoch: Number(release.epoch),
      pinnedBlock: Number(release.pinnedBlock),
      statsDigest: release.statsDigest,
      epsilonPerfE6: release.epsilonPerfE6.toString(),
      cumulativeEpsilonE6: release.cumulativeEpsilonE6.toString(),
      txHash: receipt.hash,
      noiseCommit: pledge,
      published
    };
    // The samples this release spent are gone; ones that arrived while it was
    // in flight belong to the next. The last NAV point stays as the next
    // window's drawdown baseline.
    pooledReturns = pooledReturns.slice(samples.length);
    marketNavSeries = marketNavSeries.slice(-1);
    log(`[reporter] epoch ${lastRelease.epoch}: ${published.sampleSize} samples, cumulative epsilon ${lastRelease.cumulativeEpsilonE6} -> ${receipt.hash}`);
    // The next window opens now, so its pledge goes in now. The release has
    // landed; a pledge that does not is retried by the next publish.
    if (pledge) {
      try {
        await sendPledge(lastRelease.epoch + 1);
      } catch (error) {
        log(`[reporter] epoch ${lastRelease.epoch + 1}: the noise pledge did not land: ${describe(error)}`);
      }
    }
    return lastRelease;
  }

  function publish() {
    if (resetting()) return Promise.reject(refuse("the demo is being reset; try again in a few seconds", 409));
    publishing ??= publishNow().finally(() => {
      publishing = null;
    });
    return publishing;
  }

  return { status, publish, sample };
}
