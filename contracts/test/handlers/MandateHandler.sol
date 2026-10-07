// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {MandateRiskGuard} from "../../src/MandateRiskGuard.sol";
import {MockVenueAdapter} from "../../src/MockVenueAdapter.sol";
import {DeterministicMockVenue} from "../../src/mocks/DeterministicMockVenue.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {RiskLimits} from "../../src/interfaces/IMandate.sol";

/// @notice Bounded, revert-tolerant entry points for the invariant fuzzer.
/// @dev Every legitimate guard rejection (LeverageExceeded, CooldownActive,
///      StressBreach, MarkTooOld, ...) is swallowed here so one expected revert does
///      not end the run -- `foundry.toml` also sets `fail_on_revert = false` for the
///      same reason. Only a property the contracts are supposed to guarantee ever
///      flips a ghost flag to true; the invariant_* functions in Mandate.invariant.t.sol
///      assert each flag stays false for the life of the run.
contract MandateHandler is Test {
    MandateVault public vault;
    MandateRiskGuard public guard;
    MockVenueAdapter public adapter;
    DeterministicMockVenue public venue;
    MockUSDC public usdc;
    address public agent;
    address public owner;

    address[] public allocators;
    address public constant LOCKED_SHARES_HOLDER = address(0xdead);

    bool public ghost_agentReceivedFunds;
    bool public ghost_stateRegressed;
    bool public ghost_allocateWithoutLock;
    bool public ghost_allocateWhenNotActive;
    bool public ghost_executeWhenNotActive;
    bool public ghost_unwindWhenNotFrozen;
    bool public ghost_unwindIncreasedPosition;
    bool public ghost_closedPositionReopened;
    bool public ghost_closedLeftTerminal;
    bool public ghost_configureAfterLock;
    bool public ghost_setAdapterAfterLock;
    bool public ghost_reduceOnlyOrderStressRejected;

    uint8 internal lastState;
    bool internal sawClosed;

    constructor(
        MandateVault vault_,
        MandateRiskGuard guard_,
        MockVenueAdapter adapter_,
        DeterministicMockVenue venue_,
        MockUSDC usdc_,
        address agent_,
        address[] memory allocators_,
        address owner_
    ) {
        vault = vault_;
        guard = guard_;
        adapter = adapter_;
        venue = venue_;
        usdc = usdc_;
        agent = agent_;
        owner = owner_;
        for (uint256 i; i < allocators_.length; i++) allocators.push(allocators_[i]);
        lastState = uint8(vault.state());
    }

    modifier track() {
        _;
        _checkState();
        _checkCustody();
    }

    function _checkState() internal {
        uint8 cur = uint8(vault.state());
        if (cur < lastState) ghost_stateRegressed = true;
        if (lastState == 2 && cur != 2) ghost_closedLeftTerminal = true;
        if (cur == 2) {
            sawClosed = true;
            (uint256 posNotional,) = adapter.positionState(address(vault));
            if (posNotional != 0) ghost_closedPositionReopened = true;
        }
        lastState = cur;
    }

    function _checkCustody() internal {
        if (usdc.balanceOf(agent) != 0) ghost_agentReceivedFunds = true;
    }

    function _allocator(uint256 seed) internal view returns (address) {
        return allocators[seed % allocators.length];
    }

    function _abs(int256 v) internal pure returns (uint256) {
        return v >= 0 ? uint256(v) : uint256(-v);
    }

    function allocate(uint256 actorSeed, uint256 amount) external track {
        address who = _allocator(actorSeed);
        // usdc.mint() is onlyOwner and the handler is not the owner (the test
        // contract that deploys everything in setUp() is); allocators are
        // pre-funded there instead, so bound to what they were actually given.
        amount = bound(amount, 1, usdc.balanceOf(who));
        if (amount == 0) return;
        vm.prank(who);
        usdc.approve(address(vault), amount);

        bool locked = guard.termsLocked(address(vault));
        MandateVault.AgentState stateBefore = vault.state();

        vm.prank(who);
        try vault.allocate(amount, who) {
            if (!locked) ghost_allocateWithoutLock = true;
            if (stateBefore != MandateVault.AgentState.Active) ghost_allocateWhenNotActive = true;
        } catch {}
    }

    function withdraw(uint256 actorSeed, uint256 sharesAmount) external track {
        address who = _allocator(actorSeed);
        uint256 bal = vault.balanceOf(who);
        if (bal == 0) return;
        sharesAmount = bound(sharesAmount, 1, bal);
        vm.prank(who);
        try vault.withdraw(sharesAmount, who) {} catch {}
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 amount) external track {
        address from = _allocator(fromSeed);
        address to = _allocator(toSeed);
        uint256 bal = vault.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        try vault.transferShares(to, amount) {} catch {}
    }

    function executeOrder(int256 sizeDeltaE18) external track {
        sizeDeltaE18 = bound(sizeDeltaE18, -5e18, 5e18);
        if (sizeDeltaE18 == 0) return;

        uint256 price = venue.priceE18();
        uint256 limitPrice = sizeDeltaE18 > 0 ? price * 2 : price / 2;
        bytes memory order = abi.encode(sizeDeltaE18, limitPrice);

        int256 currentSize = venue.positionSizeE18(address(vault));
        int256 resultingSize = currentSize + sizeDeltaE18;
        uint256 totalBefore = (_abs(currentSize) * price) / 1e18;
        uint256 totalAfter = (_abs(resultingSize) * price) / 1e18;
        // Crossing through flat opens a new position on the other side, so the guard
        // treats it as added exposure even when the total does not grow.
        bool flips = (currentSize > 0 && resultingSize < 0) || (currentSize < 0 && resultingSize > 0);
        bool reduceOnly = totalAfter <= totalBefore && !flips;

        MandateVault.AgentState stateBefore = vault.state();
        vm.prank(agent);
        try vault.execute(address(adapter), order) {
            if (stateBefore != MandateVault.AgentState.Active) ghost_executeWhenNotActive = true;
        } catch (bytes memory reason) {
            if (reduceOnly && _isStressBreach(reason)) {
                ghost_reduceOnlyOrderStressRejected = true;
            }
        }
    }

    function _isStressBreach(bytes memory reason) internal pure returns (bool) {
        if (reason.length < 4) return false;
        bytes4 selector;
        assembly {
            selector := mload(add(reason, 32))
        }
        return selector == bytes4(keccak256("StressBreach(uint256,uint256,uint256)"));
    }

    function poke() external track {
        vm.prank(address(0xCAFE));
        try guard.poke(address(vault), address(adapter)) {} catch {}
    }

    function unwind() external track {
        MandateVault.AgentState stateBefore = vault.state();
        (uint256 posBefore,) = adapter.positionState(address(vault));
        vm.prank(address(0xBEEF));
        try vault.unwind() {
            if (stateBefore != MandateVault.AgentState.Frozen) ghost_unwindWhenNotFrozen = true;
            (uint256 posAfter,) = adapter.positionState(address(vault));
            if (posAfter > posBefore) ghost_unwindIncreasedPosition = true;
        } catch {}
    }

    function shockPrice(uint256 seed, bool up) external track {
        uint256 current = venue.priceE18();
        uint256 pct = bound(seed, 1, 9_000);
        uint256 newPrice = up ? current + (current * pct) / 10_000 : current - (current * pct) / 10_000;
        if (newPrice == 0) newPrice = 1;
        vm.prank(owner);
        venue.setPrice(newPrice);
    }

    /// @dev Up to two mark ages per step: most sequences keep a usable mark, and a
    ///      run of warps without a price update can still reach the unobservable
    ///      window (three mark ages) for tryFreezeUnobservable.
    function warp(uint256 secs) external track {
        secs = bound(secs, 0, 120);
        vm.warp(block.timestamp + secs);
    }

    function tryFreezeUnobservable() external track {
        try guard.freezeUnobservable(address(vault)) {} catch {}
    }

    function tryReconfigure(uint16 maxLev) external track {
        bool locked = guard.termsLocked(address(vault));
        RiskLimits memory dummy;
        dummy.maxLeverageX100 = maxLev;
        vm.prank(owner);
        try guard.configure(address(vault), dummy) {
            if (locked) ghost_configureAfterLock = true;
        } catch {}
    }

    function tryReallowAdapter(bool allowed) external track {
        bool locked = guard.termsLocked(address(vault));
        vm.prank(owner);
        try guard.setAdapter(address(vault), address(adapter), allowed) {
            if (locked) ghost_setAdapterAfterLock = true;
        } catch {}
    }
}
