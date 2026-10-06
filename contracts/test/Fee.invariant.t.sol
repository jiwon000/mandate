// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateRiskGuard} from "../src/MandateRiskGuard.sol";
import {MockVenueAdapter} from "../src/MockVenueAdapter.sol";
import {DeterministicMockVenue} from "../src/mocks/DeterministicMockVenue.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {RiskLimits, TradeTerms, FeeTerms} from "../src/interfaces/IMandate.sol";
import {MandateHandler} from "./handlers/MandateHandler.sol";
import {FeeHandler} from "./handlers/FeeHandler.sol";

/// @notice Stateful fuzzing of the fee and trade terms: a vault charging a 2%
///         management and 20% performance fee, long only, at most five orders a day
///         that add exposure. MandateHandler drives deposits, trades, price shocks,
///         freezes and unwinds; FeeHandler accrues fees, lets the agent cash out its
///         fee shares and counts the day's trades.
contract FeeInvariants is Test {
    MandateVault internal vault;
    MandateRiskGuard internal guard;
    MockVenueAdapter internal adapter;
    DeterministicMockVenue internal venue;
    MockUSDC internal usdc;
    MandateHandler internal handler;
    FeeHandler internal fees;

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
        guard.configureTerms(
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
            }),
            TradeTerms({
                allowedMarkets: 1,
                direction: 1,
                maxPriceDeviationBps: 0,
                maxTradesPerDay: 5,
                maxDailyLossBps: 0,
                maxHoldingSeconds: 0
            }),
            FeeTerms({performanceFeeBps: 2_000, managementFeeBps: 200})
        );
        guard.lockTerms(address(vault));

        for (uint256 i; i < 3; i++) {
            allocators.push(address(uint160(uint256(keccak256(abi.encode("fee allocator", i))))));
        }
        uint256 seed = 10_000e6;
        usdc.mint(allocators[0], seed);
        vm.prank(allocators[0]);
        usdc.approve(address(vault), seed);
        vm.prank(allocators[0]);
        vault.allocate(seed, allocators[0]);
        for (uint256 i; i < allocators.length; i++) {
            usdc.mint(allocators[i], 5_000_000e6);
        }

        handler = new MandateHandler(vault, guard, adapter, venue, usdc, AGENT, allocators, address(this));
        fees = new FeeHandler(vault, guard, adapter, venue, AGENT);
        targetContract(address(handler));
        targetContract(address(fees));
    }

    /// Fee shares are real shares: the supply is every allocator's balance, the
    /// agent's fee shares and the locked MIN_SHARES.
    function invariant_supplyIncludesFeeShares() public view {
        uint256 sum = vault.balanceOf(LOCKED_SHARES_HOLDER) + vault.balanceOf(AGENT);
        for (uint256 i; i < allocators.length; i++) sum += vault.balanceOf(allocators[i]);
        assertEq(sum, vault.totalSupply());
    }

    /// The performance fee's high-water mark only ever rises.
    function invariant_highWaterNeverFalls() public view {
        assertFalse(fees.ghost_highWaterFell());
    }

    /// No fee is charged once the vault is Frozen or Closed.
    function invariant_noFeeAfterFreeze() public view {
        assertFalse(fees.ghost_feeWhileNotActive());
    }

    /// A fee never takes more than the terms allow for the time and gain behind it.
    function invariant_feeWithinTerms() public view {
        assertFalse(fees.ghost_feeOverCharged());
    }

    /// Long only means the vault is never short, whichever handler traded.
    function invariant_longOnlyHolds() public view {
        assertFalse(fees.ghost_shortOnLongOnly());
    }

    /// The guard refuses the sixth order of a day that adds exposure.
    function invariant_dailyTradeCapHolds() public view {
        assertFalse(fees.ghost_tooManyTradesInADay());
    }

    /// The state machine still only moves forward with fees switched on.
    function invariant_stateNeverRegresses() public view {
        assertFalse(handler.ghost_stateRegressed());
        assertFalse(handler.ghost_closedLeftTerminal());
    }
}
