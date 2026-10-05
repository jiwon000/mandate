// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {MandateRiskGuard} from "../../src/MandateRiskGuard.sol";
import {MockVenueAdapter} from "../../src/MockVenueAdapter.sol";
import {DeterministicMockVenue} from "../../src/mocks/DeterministicMockVenue.sol";
import {FeeTerms, TradeTerms} from "../../src/interfaces/IMandate.sol";

/// @notice Fee and trade-term entry points for Fee.invariant.t.sol, run beside
///         MandateHandler against a vault with fees, long-only direction and a
///         daily trade cap. Same pattern: rejections are swallowed, and only a
///         property the contracts promise flips a ghost flag.
contract FeeHandler is Test {
    MandateVault public vault;
    MandateRiskGuard public guard;
    MockVenueAdapter public adapter;
    DeterministicMockVenue public venue;
    address public agent;

    bool public ghost_highWaterFell;
    bool public ghost_feeWhileNotActive;
    bool public ghost_feeOverCharged;
    bool public ghost_shortOnLongOnly;
    bool public ghost_tooManyTradesInADay;

    /// Coverage counters, to check by hand that a campaign mints fee shares and hits
    /// the daily cap; not every 32-call run does, so no invariant asserts them.
    uint256 public feeMints;
    uint256 public capRefusals;

    uint256 internal lastHighWater;
    uint256 internal tradeDay;
    uint256 internal tradesToday;

    constructor(
        MandateVault vault_,
        MandateRiskGuard guard_,
        MockVenueAdapter adapter_,
        DeterministicMockVenue venue_,
        address agent_
    ) {
        vault = vault_;
        guard = guard_;
        adapter = adapter_;
        venue = venue_;
        agent = agent_;
        lastHighWater = vault.feeHighWaterNavPerShare();
    }

    modifier track() {
        bool active = vault.state() == MandateVault.AgentState.Active;
        uint256 agentShares = vault.balanceOf(agent);
        _;
        if (!active && vault.balanceOf(agent) > agentShares) ghost_feeWhileNotActive = true;
        uint256 highWater = vault.feeHighWaterNavPerShare();
        if (highWater < lastHighWater) ghost_highWaterFell = true;
        lastHighWater = highWater;
        if (venue.positionSizeE18(address(vault)) < 0) ghost_shortOnLongOnly = true;
    }

    /// @dev Checks the minted shares against the terms from outside the vault's own
    ///      arithmetic: their value at the post-fee NAV may not exceed the management
    ///      fee for the elapsed time plus the performance fee on the gain above the
    ///      high-water mark.
    function accrueFees() external track {
        uint256 supply = vault.totalSupply();
        (uint256 equity,) = vault.markedAssets();
        uint256 elapsed = block.timestamp - vault.lastFeeAccrual();
        uint256 highWater = vault.feeHighWaterNavPerShare();
        FeeTerms memory fee = guard.feesOf(address(vault));
        try vault.accrueFees() returns (uint256 minted) {
            if (minted == 0 || supply == 0) return;
            feeMints += 1;
            uint256 value = (minted * equity) / (supply + minted);
            uint256 cap = (equity * fee.managementFeeBps * elapsed) / (10_000 * 365 days);
            uint256 nav = (equity * 1e18) / supply;
            if (nav > highWater) cap += ((nav - highWater) * supply / 1e18) * fee.performanceFeeBps / 10_000;
            if (value > cap + 2) ghost_feeOverCharged = true;
        } catch {}
    }

    function agentWithdraw(uint256 shares) external track {
        uint256 bal = vault.balanceOf(agent);
        if (bal == 0) return;
        shares = bound(shares, 1, bal);
        vm.prank(agent);
        try vault.withdraw(shares, agent) {} catch {}
    }

    /// @dev Orders that add exposure count toward the day's cap; the guard must
    ///      refuse the one past it.
    function tradeCounted(int256 sizeDeltaE18) external track {
        sizeDeltaE18 = bound(sizeDeltaE18, -3e18, 3e18);
        if (sizeDeltaE18 == 0) return;
        uint256 price = venue.priceE18();
        bytes memory order = abi.encode(sizeDeltaE18, sizeDeltaE18 > 0 ? price * 2 : price / 2);
        int256 before = venue.positionSizeE18(address(vault));
        int256 after_ = before + sizeDeltaE18;
        bool adds = _abs(after_) > _abs(before);
        vm.prank(agent);
        try vault.execute(address(adapter), order) {
            if (!adds) return;
            uint256 day = block.timestamp / 1 days;
            if (day != tradeDay) {
                tradeDay = day;
                tradesToday = 0;
            }
            tradesToday += 1;
            (,,, uint16 maxTradesPerDay,,) = _trade();
            if (tradesToday > maxTradesPerDay) ghost_tooManyTradesInADay = true;
        } catch (bytes memory reason) {
            if (reason.length >= 4 && bytes4(reason) == bytes4(keccak256("DailyTradesExceeded()"))) capRefusals += 1;
        }
    }

    function _trade() internal view returns (uint32, uint8, uint16, uint16, uint16, uint32) {
        TradeTerms memory t = guard.tradeTermsOf(address(vault));
        return (t.allowedMarkets, t.direction, t.maxPriceDeviationBps, t.maxTradesPerDay, t.maxDailyLossBps, t.maxHoldingSeconds);
    }

    function _abs(int256 v) internal pure returns (uint256) {
        return v >= 0 ? uint256(v) : uint256(-v);
    }
}
