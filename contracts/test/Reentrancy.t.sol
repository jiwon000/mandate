// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateRiskGuard} from "../src/MandateRiskGuard.sol";
import {MockVenueAdapter} from "../src/MockVenueAdapter.sol";
import {DeterministicMockVenue} from "../src/mocks/DeterministicMockVenue.sol";
import {RiskLimits} from "../src/interfaces/IMandate.sol";
import {MaliciousReentrantToken} from "./mocks/MaliciousReentrantToken.sol";

/// @notice mandate-technical-spec-v0.2.md 7 ("Reentrancy 및 malicious adapter/token
///         fuzzing") and invariant #10 ("malicious token/venue callback이 Vault
///         회계에 reentrancy를 일으킬 수 없다"), exercised against the real
///         MandateVault with a hostile asset standing in for USDC.
contract ReentrancyTest is Test {
    MandateVault internal vault;
    MandateRiskGuard internal guard;
    MockVenueAdapter internal adapter;
    DeterministicMockVenue internal venue;
    MaliciousReentrantToken internal token;

    address internal constant AGENT = address(0xA6E47);
    address internal allocator = address(0xA11CE);

    function setUp() public {
        token = new MaliciousReentrantToken();
        guard = new MandateRiskGuard();
        venue = new DeterministicMockVenue(2_000e18);
        adapter = new MockVenueAdapter(venue);
        vault = new MandateVault(token, guard, AGENT, adapter);

        venue.setAdapter(address(adapter), true);
        guard.setAdapter(address(vault), address(adapter), true);
        guard.configure(
            address(vault),
            RiskLimits({
                maxLeverageX100: 500,
                maxDrawdownBps: 2_000,
                minBlocksBetweenTrades: 0,
                maxMarkAgeSeconds: 60,
                maxOrderNotional: 50_000e18,
                maxPositionNotional: 50_000e18,
                maxTotalNotional: 50_000e18,
                maxBlockNotional: 50_000e18,
                volWindowSeconds: 0,
                stressHorizonSeconds: 0,
                stressSigmasX10: 0
            })
        );
        guard.lockTerms(address(vault));

        token.mint(allocator, 10_000e6);
        vm.prank(allocator);
        token.approve(address(vault), type(uint256).max);
    }

    /// allocate() pulls the asset in with transferFrom before it credits shares; a
    /// token that tries to call back into withdraw() from inside that transfer must
    /// hit the ReentrancyGuard, not a vault with an inconsistent half-updated balance.
    function test_allocateCannotReenterWithdraw() public {
        vm.prank(allocator);
        vault.allocate(1_000e6, allocator);

        bytes memory reentrant = abi.encodeCall(MandateVault.withdraw, (1, allocator));
        token.arm(address(vault), reentrant);

        vm.prank(allocator);
        vm.expectRevert();
        vault.allocate(1_000e6, allocator);
    }

    /// withdraw() updates balances before paying out; a token that tries to call back
    /// into allocate() from inside that payout must still hit the guard.
    function test_withdrawCannotReenterAllocate() public {
        vm.prank(allocator);
        vault.allocate(2_000e6, allocator);
        uint256 shares = vault.balanceOf(allocator);

        bytes memory reentrant = abi.encodeCall(MandateVault.allocate, (100e6, allocator));
        token.arm(address(vault), reentrant);

        vm.prank(allocator);
        vm.expectRevert();
        vault.withdraw(shares, allocator);
    }

    /// Sanity check: an unarmed malicious token behaves like an honest one, so the
    /// two tests above are failing on reentrancy specifically, not on some unrelated
    /// side effect of swapping the asset.
    function test_honestFlowStillWorksWithTheSameToken() public {
        vm.prank(allocator);
        vault.allocate(1_000e6, allocator);
        uint256 shares = vault.balanceOf(allocator);
        assertGt(shares, 0);

        vm.prank(allocator);
        vault.withdraw(shares, allocator);
        assertEq(vault.balanceOf(allocator), 0);
    }
}
