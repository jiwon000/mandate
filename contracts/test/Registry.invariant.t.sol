// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {RegistryHandler} from "./handlers/RegistryHandler.sol";

/// @notice Stateful fuzzing of core invariant #8 in mandate-technical-spec-v0.2.md
///         ("cumulative ε는 단조 증가하고 상한 초과 릴리즈는 거부된다"), now that
///         MandateRegistry exists to fuzz it against. Invariant #9 (same epoch/
///         pinnedBlock digest cannot change) is covered by registry.test.mjs's
///         targeted unit tests; the property worth a random-sequence fuzzer is
///         the epsilon ledger, which only gets interesting after many calls.
contract RegistryInvariants is Test {
    MandateRegistry internal registry;
    RegistryHandler internal handler;
    uint256 internal constant REPORTER_KEY = 0xA11CE;
    uint256 internal constant EPSILON_CAP = 2_000_000;

    function setUp() public {
        registry = new MandateRegistry();
        registry.setReporter(vm.addr(REPORTER_KEY));
        registry.setEpsilonCap(EPSILON_CAP);

        handler = new RegistryHandler(registry, REPORTER_KEY, EPSILON_CAP);
        targetContract(address(handler));
    }

    /// Invariant #8 (monotonic): the on-chain ledger never moves backward.
    function invariant_cumulativeEpsilonNeverRegresses() public view {
        assertFalse(handler.ghost_cumulativeRegressed());
    }

    /// Invariant #8 (cap): no accepted release ever reports a cumulative total
    /// past the configured cap.
    function invariant_cumulativeEpsilonNeverExceedsCap() public view {
        assertFalse(handler.ghost_capExceeded());
        assertLe(registry.cumulativeEpsilonE6(), EPSILON_CAP);
    }

    /// The contract's own ledger always equals the sum of epsilon from releases
    /// that actually succeeded -- no accepted call is ever "free" epsilon, and no
    /// successful call is ever double-counted or dropped.
    function invariant_ledgerMatchesAcceptedReleases() public view {
        assertFalse(handler.ghost_cumulativeDisagreesWithLedger());
        assertEq(registry.cumulativeEpsilonE6(), handler.ghost_acceptedEpsilon());
    }

    /// Invariant #9's epoch half: a successful post never reuses or rewinds an
    /// epoch that already has a release.
    function invariant_epochNeverReused() public view {
        assertFalse(handler.ghost_epochReused());
    }
}
