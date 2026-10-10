// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateRiskGuard} from "../src/MandateRiskGuard.sol";
import {MockVenueAdapter} from "../src/MockVenueAdapter.sol";
import {DeterministicMockVenue} from "../src/mocks/DeterministicMockVenue.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {RiskLimits} from "../src/interfaces/IMandate.sol";

/// @notice The unwind bounty floor's payout rule, fuzzed over the floor and the vault's
///         size: a step pays max(0.01% of cash, floor), never past 0.2% of cash, and a
///         vault without a floor pays the 0.01% share exactly as before.
contract UnwindBountyFloorTest is Test {
    MockUSDC internal usdc;
    MandateRiskGuard internal guard;
    DeterministicMockVenue internal venue;
    MockVenueAdapter internal adapter;

    address internal constant AGENT = address(0xA6E47);
    address internal constant ALLOCATOR = address(0xA11CE);
    address internal constant KEEPER = address(0xBEEF);

    function setUp() public {
        // Off Foundry's day-zero clock: a guard reads an unset daily-loss pause as "today"
        // while today is day 0, as no live chain ever is.
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        guard = new MandateRiskGuard();
        venue = new DeterministicMockVenue(2_000e18);
        adapter = new MockVenueAdapter(venue);
        venue.setAdapter(address(adapter), true);
    }

    /// A vault with `floor` set and `deposit` of cash, long at 1.00x from $2000, marked
    /// at $1800 and frozen by poke() on the 10% drawdown.
    function _frozenVault(uint256 floor, uint256 deposit) internal returns (MandateVault vault) {
        vault = new MandateVault(usdc, guard, AGENT, adapter);
        guard.setAdapter(address(vault), address(adapter), true);
        guard.configure(
            address(vault),
            RiskLimits({
                maxLeverageX100: 300,
                maxDrawdownBps: 200,
                minBlocksBetweenTrades: 0,
                maxMarkAgeSeconds: 60,
                maxOrderNotional: type(uint128).max,
                maxPositionNotional: type(uint128).max,
                maxTotalNotional: type(uint128).max,
                maxBlockNotional: type(uint128).max,
                volWindowSeconds: 0,
                stressHorizonSeconds: 0,
                stressSigmasX10: 0
            })
        );
        if (floor != 0) guard.setUnwindBountyFloor(address(vault), floor);
        guard.lockTerms(address(vault));

        usdc.mint(ALLOCATOR, deposit);
        vm.startPrank(ALLOCATOR);
        usdc.approve(address(vault), deposit);
        vault.allocate(deposit, ALLOCATOR);
        vm.stopPrank();

        // Notional equal to the deposit: size = deposit (6 decimals -> 1e18) / $2000.
        int256 size = int256((deposit * 1e12) / 2_000);
        vm.prank(AGENT);
        vault.execute(address(adapter), abi.encode(size, uint256(2_100e18)));
        venue.setPrice(1_800e18);
        guard.poke(address(vault), address(adapter));
        assertEq(uint8(vault.state()), 1, "Frozen");
    }

    function _expected(uint256 cash, uint256 floor) internal pure returns (uint256 bounty) {
        bounty = cash / 10_000;
        if (floor > bounty) {
            uint256 cap = (cash * 20) / 10_000;
            bounty = floor > cap ? cap : floor;
        }
    }

    function testFuzz_stepPaysMaxOfShareAndFloorCappedByCash(uint256 floor, uint256 deposit) public {
        deposit = bound(deposit, 10e6, 1e13); // 10 mUSDC to ten million
        MandateVault vault = _frozenVault(floor, deposit);
        uint256 cash = usdc.balanceOf(address(vault));
        uint256 expected = _expected(cash, floor);

        vm.roll(block.number + 1);
        vm.prank(KEEPER);
        vault.unwind();

        uint256 paid = usdc.balanceOf(KEEPER);
        assertEq(paid, expected, "max(share, floor) under the cap");
        assertLe(paid, (cash * 20) / 10_000, "never past 0.2% of cash");
        assertLe(paid, cash, "never past the cash itself");
        assertGe(paid, cash / 10_000, "never under the share a vault without a floor pays");
        if (floor <= (cash * 20) / 10_000) assertGe(paid, floor, "a floor the cap allows is paid in full");
    }

    function testFuzz_noFloorPaysTheShareExactly(uint256 deposit) public {
        deposit = bound(deposit, 10e6, 1e13);
        MandateVault vault = _frozenVault(0, deposit);
        uint256 cash = usdc.balanceOf(address(vault));

        vm.roll(block.number + 1);
        vm.prank(KEEPER);
        vault.unwind();
        assertEq(usdc.balanceOf(KEEPER), cash / 10_000, "0.01% of cash, as before the floor existed");
    }

    function test_floorIsLockedWithTheTerms() public {
        MandateVault vault = new MandateVault(usdc, guard, AGENT, adapter);
        vm.expectRevert(MandateRiskGuard.LimitsNotConfigured.selector);
        guard.setUnwindBountyFloor(address(vault), 1);

        guard.configure(
            address(vault),
            RiskLimits(300, 200, 0, 60, 1e24, 1e24, 1e24, 1e24, 0, 0, 0)
        );
        bytes32 plain = guard.termsHash(address(vault));
        guard.setUnwindBountyFloor(address(vault), 5e5);
        assertEq(guard.unwindBountyFloorOf(address(vault)), 5e5);
        assertTrue(guard.termsHash(address(vault)) != plain, "the floor is in the hash");
        guard.setUnwindBountyFloor(address(vault), 0);
        assertEq(guard.termsHash(address(vault)), plain, "and a cleared floor restores it");

        guard.setUnwindBountyFloor(address(vault), 5e5);
        guard.lockTerms(address(vault));
        vm.expectRevert(MandateRiskGuard.LimitsLocked.selector);
        guard.setUnwindBountyFloor(address(vault), 1);
        vm.expectRevert(MandateRiskGuard.LimitsLocked.selector);
        guard.setUnwindBountyFloor(address(vault), 0);
    }
}
