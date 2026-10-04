// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";

/// @notice Bounded, revert-tolerant entry points fuzzing MandateRegistry.postLeaderboard().
/// @dev registerAgent() is single-shot and self-verifying (covered by
///      registry.test.mjs); the part worth fuzzing is the epsilon/epoch ledger,
///      which accumulates across many calls and is exactly where a hand-written
///      sequence of unit tests is weakest. Legitimate rejections (wrong signer,
///      stale epoch, bad arithmetic, over cap) are swallowed here the same way
///      MandateHandler does for the Vault/RiskGuard suite; only a property the
///      contract is supposed to guarantee ever flips a ghost flag.
contract RegistryHandler is Test {
    struct Release {
        uint256 epoch;
        uint256 pinnedBlock;
        uint256 epsilonPerfE6;
        uint256 epsilonIntentE6;
        uint256 cumulativeEpsilonE6;
        bool correctAccounting;
        bool signAsReporter;
    }

    MandateRegistry public registry;
    uint256 internal reporterKey;
    uint256 internal cap;

    // Ghost ledger: sum of epsilon actually accepted by successful posts so far,
    // tracked independently of the contract's own storage.
    uint256 public ghost_acceptedEpsilon;
    bool public ghost_cumulativeRegressed;
    bool public ghost_cumulativeDisagreesWithLedger;
    bool public ghost_capExceeded;
    bool public ghost_epochReused;
    uint256 internal lastSeenEpoch;
    bool internal sawFirstRelease;

    constructor(MandateRegistry registry_, uint256 reporterKey_, uint256 cap_) {
        registry = registry_;
        reporterKey = reporterKey_;
        cap = cap_;
    }

    function postLeaderboard(
        uint256 epochSeed,
        uint256 rollSeed,
        uint256 epsilonPerfE6,
        uint256 epsilonIntentE6,
        bool correctAccounting,
        bool signAsReporter
    ) external {
        // Foundry does not advance block.number between invariant calls on its
        // own; without this every call after the first legitimate release would
        // fail PinnedBlockNotIncreasing forever, and the ledger would never
        // accumulate across more than one successful post.
        vm.roll(block.number + bound(rollSeed, 1, 5));

        uint256 priorCumulative = registry.cumulativeEpsilonE6();
        Release memory rel = _buildRelease(epochSeed, epsilonPerfE6, epsilonIntentE6, correctAccounting, signAsReporter, priorCumulative);

        try registry.postLeaderboard(
            rel.epoch,
            rel.pinnedBlock,
            bytes32(epochSeed),
            rel.epsilonPerfE6,
            rel.epsilonIntentE6,
            rel.cumulativeEpsilonE6,
            _sign(epochSeed, rel)
        ) {
            _onAccepted(rel);
        } catch {}

        uint256 cur = registry.cumulativeEpsilonE6();
        if (cur < priorCumulative) ghost_cumulativeRegressed = true;
        if (cur != ghost_acceptedEpsilon) ghost_cumulativeDisagreesWithLedger = true;
    }

    function _buildRelease(
        uint256 epochSeed,
        uint256 epsilonPerfE6,
        uint256 epsilonIntentE6,
        bool correctAccounting,
        bool signAsReporter,
        uint256 priorCumulative
    ) internal view returns (Release memory rel) {
        // Mostly try epochs that could legitimately advance the ledger; let a
        // slice of runs retry an old epoch to exercise the rejection path too.
        rel.epoch = bound(epochSeed, 0, registry.lastEpoch() + 5);
        rel.pinnedBlock = block.number;
        rel.epsilonPerfE6 = bound(epsilonPerfE6, 0, 1_000_000);
        rel.epsilonIntentE6 = bound(epsilonIntentE6, 0, 1_000_000);
        uint256 correct = priorCumulative + rel.epsilonPerfE6 + rel.epsilonIntentE6;
        rel.cumulativeEpsilonE6 = correctAccounting ? correct : correct + 1;
        rel.correctAccounting = correctAccounting;
        rel.signAsReporter = signAsReporter;
    }

    function _sign(uint256 epochSeed, Release memory rel) internal view returns (bytes memory signature) {
        bytes32 digest = registry.hashRelease(
            rel.epoch, rel.pinnedBlock, bytes32(epochSeed), rel.epsilonPerfE6, rel.epsilonIntentE6, rel.cumulativeEpsilonE6
        );
        uint256 signingKey = rel.signAsReporter ? reporterKey : uint256(keccak256(abi.encode("not-the-reporter", epochSeed)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    // A successful post must have advanced the epoch, matched the exact
    // additive ledger, and never crossed the cap -- the invariant functions
    // re-check all three from outside, but ghost-tracking the "ought to be
    // true" side here catches a contract that silently accepts a call it
    // should have rejected.
    function _onAccepted(Release memory rel) internal {
        if (sawFirstRelease && rel.epoch <= lastSeenEpoch) ghost_epochReused = true;
        if (!rel.correctAccounting) ghost_cumulativeDisagreesWithLedger = true;
        if (cap != 0 && rel.cumulativeEpsilonE6 > cap) ghost_capExceeded = true;
        ghost_acceptedEpsilon += rel.epsilonPerfE6 + rel.epsilonIntentE6;
        lastSeenEpoch = rel.epoch;
        sawFirstRelease = true;
    }
}
