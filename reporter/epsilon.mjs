// Mirrors MandateRegistry.postLeaderboard()'s own accounting exactly
// (mandate-technical-spec-v0.2.md core invariant 8), so a release this ledger
// accepts is guaranteed postable on-chain and the two can never silently
// drift apart. `propose()` is read-only; nothing advances until `commit()`
// runs, which the caller should only do after the transaction actually lands.
export class EpsilonLedger {
  constructor({ cap = 0n } = {}) {
    this.cap = BigInt(cap); // 0 = no cap, same convention as MandateRegistry.epsilonCap
    this.cumulative = 0n;
    this.hasReleased = false;
    this.lastEpoch = 0n;
  }

  /// Returns the cumulativeEpsilonE6 a release at `epoch` would carry, or
  /// throws the same class of rejection MandateRegistry.postLeaderboard()
  /// would -- so a build never produces a signed release the contract was
  /// always going to refuse.
  propose(epoch, epsilonPerfE6, epsilonIntentE6) {
    epoch = BigInt(epoch);
    if (this.hasReleased && epoch <= this.lastEpoch) {
      throw new Error(`epoch ${epoch} does not advance past ${this.lastEpoch}`);
    }
    const cumulativeEpsilonE6 = this.cumulative + BigInt(epsilonPerfE6) + BigInt(epsilonIntentE6);
    if (this.cap !== 0n && cumulativeEpsilonE6 > this.cap) {
      throw new Error(`release would exceed the epsilon cap (${cumulativeEpsilonE6} > ${this.cap})`);
    }
    return cumulativeEpsilonE6;
  }

  /// Advance the ledger. Call only once the corresponding postLeaderboard()
  /// transaction has actually confirmed.
  commit(epoch, cumulativeEpsilonE6) {
    this.lastEpoch = BigInt(epoch);
    this.cumulative = BigInt(cumulativeEpsilonE6);
    this.hasReleased = true;
  }
}
