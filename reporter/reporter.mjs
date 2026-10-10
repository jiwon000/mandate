// Orchestrates one DP release end to end: clip and compute the real statistics,
// derive deterministic noise, package a statsDigest, and produce the EIP-712
// signature MandateRegistry.postLeaderboard() checks. This module never sends
// a transaction itself -- the caller decides whether and when to post, and
// must call commit() only after that transaction actually confirms.
import { AbiCoder, keccak256 } from "ethers";
import { clip, mean, sharpe, maxDrawdown, laplaceScaleForMean } from "./stats.mjs";
import { commitmentOf, deriveSeed, laplaceSamples } from "./noise.mjs";
import { EpsilonLedger } from "./epsilon.mjs";

const coder = AbiCoder.defaultAbiCoder();

export const RELEASE_TYPES = {
  LeaderboardRelease: [
    { name: "epoch", type: "uint256" },
    { name: "pinnedBlock", type: "uint256" },
    { name: "statsDigest", type: "bytes32" },
    { name: "epsilonPerfE6", type: "uint256" },
    { name: "epsilonIntentE6", type: "uint256" },
    { name: "cumulativeEpsilonE6", type: "uint256" }
  ]
};

const FIXED_POINT = 1_000_000;
const toFixedE6 = (value) => BigInt(Math.round(value * FIXED_POINT));

export class DPReporter {
  /// `reporterSecret` seeds the noise and never leaves this process.
  /// `signer` authorizes the release on MandateRegistry -- a separate key in
  /// production, though nothing stops them from being the same account in a
  /// demo. `cap`/`clipBound`/`epsilon`/`statsVersion` are the server-fixed
  /// configuration mandate-technical-spec-v0.2.md 4.3 calls for: cadence and
  /// epsilon are not something a release can choose for itself.
  constructor({
    reporterSecret,
    signer,
    registryAddress,
    chainId,
    cap = 0n,
    clipBound = 0.1,
    epsilon = 1.0,
    statsVersion = 1
  }) {
    if (!reporterSecret) throw new Error("reporterSecret is required");
    if (!signer) throw new Error("signer is required");
    this.reporterSecret = reporterSecret;
    this.signer = signer;
    this.domain = { name: "MandateRegistry", version: "1", chainId, verifyingContract: registryAddress };
    this.ledger = new EpsilonLedger({ cap });
    this.clipBound = clipBound;
    this.epsilon = epsilon;
    this.statsVersion = statsVersion;
  }

  /// Build and sign a release. Public data only, per the 2026-10-04 scoping
  /// decision: `perTradeReturns` and `navSeries` are reconstructed from public
  /// Marked/Executed/EpochSettled events, not from any private watchlist or
  /// pre-settlement intent -- this is "public settlement analytics" and the
  /// performance leaderboard (mandate-technical-spec-v0.2.md 4.1), not
  /// "private demand analytics". epsilonIntentE6 is therefore always 0 here.
  async buildRelease({ epoch, pinnedBlock, perTradeReturns, navSeries }) {
    const clipped = perTradeReturns.map((r) => clip(r, this.clipBound));
    const realMean = mean(clipped);
    const realSharpe = sharpe(clipped);
    const realMaxDrawdown = maxDrawdown(navSeries);

    const epsilonPerfE6 = toFixedE6(this.epsilon);
    const epsilonIntentE6 = 0n;
    const cumulativeEpsilonE6 = this.ledger.propose(epoch, epsilonPerfE6, epsilonIntentE6);

    const seed = this.#seedFor(epoch);
    // This scale is derived from the mean's own sensitivity (2*clipBound/N) and
    // reused for all three draws below. The stated epsilon is an exact, provable
    // DP guarantee for the mean only -- Sharpe's and max-drawdown's own global
    // sensitivity under clipped inputs has not been derived, so their noise is
    // indicative, not independently epsilon-accounted. Documented in README's
    // "Published ε vs Privacy Simulator" section; not treated as a bug to fix
    // under time pressure, since a wrong hand-derived sensitivity bound would be
    // worse than an honestly scoped one.
    const scale = laplaceScaleForMean(this.clipBound, clipped.length, this.epsilon);
    const [meanNoise, sharpeNoise, drawdownNoise] = laplaceSamples(seed, 3, scale);

    const noisyMean = realMean + meanNoise;
    const noisySharpe = realSharpe + sharpeNoise;
    const noisyMaxDrawdown = Math.min(1, Math.max(0, realMaxDrawdown + drawdownNoise));

    const statsDigest = keccak256(
      coder.encode(
        ["uint256", "int256", "int256", "uint256", "uint256"],
        [
          BigInt(this.statsVersion),
          toFixedE6(noisyMean),
          toFixedE6(noisySharpe),
          toFixedE6(noisyMaxDrawdown),
          BigInt(clipped.length)
        ]
      )
    );

    const release = {
      epoch: BigInt(epoch),
      pinnedBlock: BigInt(pinnedBlock),
      statsDigest,
      epsilonPerfE6,
      epsilonIntentE6,
      cumulativeEpsilonE6
    };
    const signature = await this.signer.signTypedData(this.domain, RELEASE_TYPES, release);

    return {
      release,
      signature,
      // What a UI would actually render; its hash is `statsDigest`, so a
      // viewer can recompute and check it against what Registry anchored
      // on-chain without trusting this process a second time.
      published: {
        statsVersion: this.statsVersion,
        sampleSize: clipped.length,
        epsilon: this.epsilon,
        clipBound: this.clipBound,
        scale,
        noisyMean,
        noisySharpe,
        noisyMaxDrawdown,
        // The pledge this release answers to, for comparison with what
        // MandateRegistry.noiseCommitOf(epoch) recorded.
        noiseCommit: commitmentOf(seed)
      }
    };
  }

  /// Advance the internal ledger. Call only once postLeaderboard() for this
  /// release has actually confirmed on-chain.
  commit(epoch, cumulativeEpsilonE6) {
    this.ledger.commit(epoch, cumulativeEpsilonE6);
  }

  /// keccak256 of the seed epoch `epoch` will be noised with -- what to send to
  /// MandateRegistry.commitNoiseSeed() before the window's data exists. Only
  /// the hash: the seed never leaves this class except through
  /// exportSeedForAudit().
  commitmentFor(epoch) {
    return commitmentOf(this.#seedFor(epoch));
  }

  /// The seed itself, for handing to an auditor out of band (0x hex). With it
  /// and the published numbers, `contracts/script/verify-noise.mjs --seed`
  /// recomputes the noise and the exact aggregate of that one epoch -- that is
  /// the point, and also why it must never be published: the release's
  /// epsilon guarantee is void for anyone who holds this.
  exportSeedForAudit(epoch) {
    return `0x${this.#seedFor(epoch).toString("hex")}`;
  }

  #seedFor(epoch) {
    return deriveSeed(this.reporterSecret, {
      domainSeparator: this.domain.verifyingContract,
      epochId: epoch,
      statsVersion: this.statsVersion
    });
  }
}
