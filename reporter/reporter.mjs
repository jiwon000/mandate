// Orchestrates one DP release end to end: clip and compute the real statistics,
// derive deterministic noise, package a statsDigest, and produce the EIP-712
// signature MandateRegistry.postLeaderboard() checks. This module never sends
// a transaction itself -- the caller decides whether and when to post, and
// must call commit() only after that transaction actually confirms.
import { AbiCoder, keccak256 } from "ethers";
import { clip, mean, sharpe, maxDrawdown, laplaceScaleForMean } from "./stats.mjs";
import { deriveSeed, laplaceSamples } from "./noise.mjs";
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

    const seed = deriveSeed(this.reporterSecret, {
      domainSeparator: this.domain.verifyingContract,
      epochId: epoch,
      pinnedBlock,
      statsVersion: this.statsVersion
    });
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
        noisyMaxDrawdown
      }
    };
  }

  /// Advance the internal ledger. Call only once postLeaderboard() for this
  /// release has actually confirmed on-chain.
  commit(epoch, cumulativeEpsilonE6) {
    this.ledger.commit(epoch, cumulativeEpsilonE6);
  }
}
