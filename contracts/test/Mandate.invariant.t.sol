// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateRiskGuard} from "../src/MandateRiskGuard.sol";
import {MockVenueAdapter} from "../src/MockVenueAdapter.sol";
import {DeterministicMockVenue} from "../src/mocks/DeterministicMockVenue.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {RiskLimits} from "../src/interfaces/IMandate.sol";
import {MandateHandler} from "./handlers/MandateHandler.sol";

/// @notice Stateful fuzzing of core invariant #6 in mandate-technical-spec-v0.2.md
///         ("핵심 불변식"), restricted to the pieces that exist today: Vault,
///         RiskGuard and the mock Adapter/venue. Registry/DP Reporter invariants
///         (#8, #9) have no contract to fuzz yet and are out of scope here.
contract MandateInvariants is Test {
    MandateVault internal vault;
    MandateRiskGuard internal guard;
    MockVenueAdapter internal adapter;
    DeterministicMockVenue internal venue;
    MockUSDC internal usdc;
    MandateHandler internal handler;

    address internal constant AGENT = address(0xA6E47);
    address internal constant LOCKED_SHARES_HOLDER = address(0xdead);
    address[] internal allocators;

    function setUp() public {
        usdc = new MockUSDC();
        guard = new MandateRiskGuard();
        venue = new DeterministicMockVenue(2_000e18);
        adapter = new MockVenueAdapter(venue);
        vault = new MandateVault(usdc, guard, AGENT, adapter);

        venue.setAdapter(address(adapter), true);
        guard.setAdapter(address(vault), address(adapter), true);
        guard.configure(
            address(vault),
            RiskLimits({
                maxLeverageX100: 500,
                maxDrawdownBps: 2_000,
                minBlocksBetweenTrades: 0,
                maxMarkAgeSeconds: 7 days,
                maxOrderNotional: 50_000e18,
                maxPositionNotional: 50_000e18,
                maxTotalNotional: 50_000e18,
                maxBlockNotional: 50_000e18,
                volWindowSeconds: 3_600,
                stressHorizonSeconds: 300,
                stressSigmasX10: 30
            })
        );
        guard.lockTerms(address(vault));

        for (uint256 i; i < 3; i++) {
            allocators.push(address(uint160(uint256(keccak256(abi.encode("allocator", i))))));
        }

        uint256 seed = 10_000e6;
        usdc.mint(allocators[0], seed);
        vm.prank(allocators[0]);
        usdc.approve(address(vault), seed);
        vm.prank(allocators[0]);
        vault.allocate(seed, allocators[0]);

        // Pre-fund every allocator the handler can act as; usdc.mint() is onlyOwner
        // and the handler is not the owner, so it cannot mint on demand mid-run.
        for (uint256 i; i < allocators.length; i++) {
            usdc.mint(allocators[i], 5_000_000e6);
        }

        handler = new MandateHandler(vault, guard, adapter, venue, usdc, AGENT, allocators, address(this));
        targetContract(address(handler));
    }

    /// Invariant #6: total shares outstanding always equals the sum of every
    /// holder's balance (the locked MIN_SHARES burn address plus every allocator
    /// the fuzzer can act as).
    function invariant_shareSupplyMatchesBalances() public view {
        uint256 sum = vault.balanceOf(LOCKED_SHARES_HOLDER);
        for (uint256 i; i < allocators.length; i++) {
            sum += vault.balanceOf(allocators[i]);
        }
        assertEq(sum, vault.totalSupply());
    }

    /// Invariant #1: the agent key can trade but never ends up holding allocator funds.
    function invariant_agentNeverCustodiesFunds() public view {
        assertFalse(handler.ghost_agentReceivedFunds());
        assertEq(usdc.balanceOf(AGENT), 0);
    }

    /// Invariant #5: Active -> Frozen -> Closed only ever moves forward.
    function invariant_stateNeverRegresses() public view {
        assertFalse(handler.ghost_stateRegressed());
    }

    /// Invariant #5: Closed is terminal, and a closed vault never shows an open position.
    function invariant_closedIsTerminal() public view {
        assertFalse(handler.ghost_closedLeftTerminal());
        assertFalse(handler.ghost_closedPositionReopened());
    }

    /// Invariant #11: allocate() only ever succeeds into a vault whose terms are
    /// locked, and only while the agent is Active.
    function invariant_allocateRespectsLockAndState() public view {
        assertFalse(handler.ghost_allocateWithoutLock());
        assertFalse(handler.ghost_allocateWhenNotActive());
    }

    /// Invariant #5: execute() never lands while the agent is Frozen or Closed.
    function invariant_executeOnlyWhenActive() public view {
        assertFalse(handler.ghost_executeWhenNotActive());
    }

    /// Invariant #5: unwind() only runs while Frozen and only ever shrinks the position.
    function invariant_unwindNeverGrowsPosition() public view {
        assertFalse(handler.ghost_unwindWhenNotFrozen());
        assertFalse(handler.ghost_unwindIncreasedPosition());
    }

    /// Invariant #11: once lockTerms() has run, configure()/setAdapter() stay dead
    /// for this vault no matter how many times the owner calls them.
    function invariant_lockedTermsStayLocked() public view {
        assertFalse(handler.ghost_configureAfterLock());
        assertFalse(handler.ghost_setAdapterAfterLock());
    }

    /// Invariant #12: the volatility clause only ever rejects an order that adds
    /// exposure; one that reduces or holds exposure flat is never refused on
    /// StressBreach grounds, however stressed the estimate is.
    function invariant_stressClauseNeverBlocksDeleveraging() public view {
        assertFalse(handler.ghost_reduceOnlyOrderStressRejected());
    }
}
