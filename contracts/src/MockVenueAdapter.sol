// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVenueAdapter, IMandateVaultView, TradePreview} from "./interfaces/IMandate.sol";
import {DeterministicMockVenue} from "./mocks/DeterministicMockVenue.sol";

/// @notice Adapter for the deterministic mock venue.
/// @dev An order is either `abi.encode(int256 sizeDeltaE18, uint256 limitPriceE18)`,
///      which trades market 0, or `abi.encode(uint256 marketId, int256 sizeDeltaE18,
///      uint256 limitPriceE18)`. Per-market notional is what `positionNotional` (and
///      the guard's maxPositionNotional) means: the largest single-market position.
///      `totalNotional` is the gross sum across markets.
contract MockVenueAdapter is IVenueAdapter {
    error OnlyVault();
    error ZeroOrder();
    error BadOrder();
    error BadFraction();

    /// @dev Vault assets are 6dp; venue notionals are 1e18. 1e12 converts between them.
    uint256 private constant ASSET_TO_E18 = 1e12;

    /// @notice Worst fill reduce() accepts, relative to the venue's current mark.
    /// @dev A real venue fills a market close some distance from its mark; this is the
    ///      distance past which the unwind step reverts and waits for the next block
    ///      rather than dumping into a hole. The mock venue fills at its mark exactly.
    uint16 public constant MAX_UNWIND_SLIPPAGE_BPS = 100;

    DeterministicMockVenue public immutable venue;

    constructor(DeterministicMockVenue venue_) {
        venue = venue_;
    }

    function decodeOrder(bytes calldata order)
        public
        pure
        returns (uint256 marketId, int256 sizeDeltaE18, uint256 limitPriceE18)
    {
        if (order.length == 64) {
            (sizeDeltaE18, limitPriceE18) = abi.decode(order, (int256, uint256));
        } else if (order.length == 96) {
            (marketId, sizeDeltaE18, limitPriceE18) = abi.decode(order, (uint256, int256, uint256));
        } else {
            revert BadOrder();
        }
    }

    function preview(address vault, bytes calldata order) public view returns (TradePreview memory p) {
        (uint256 marketId, int256 sizeDeltaE18, uint256 limitPriceE18) = decodeOrder(order);
        if (sizeDeltaE18 == 0) revert ZeroOrder();

        uint256 price = venue.priceOf(marketId);
        int256 resultingSize = venue.positionOf(vault, marketId) + sizeDeltaE18;
        p.orderNotional = Math.mulDiv(_abs(sizeDeltaE18), price, 1e18);

        uint256 count = venue.marketCount();
        for (uint256 m; m < count; ++m) {
            uint256 notional = m == marketId
                ? Math.mulDiv(_abs(resultingSize), price, 1e18)
                : Math.mulDiv(_abs(venue.positionOf(vault, m)), venue.priceOf(m), 1e18);
            if (notional > p.expectedPositionNotional) p.expectedPositionNotional = notional;
            p.expectedTotalNotional += notional;
        }

        // Leverage is measured against mark equity, not the idle cash balance: an agent
        // sitting on an underwater position must not look under-levered just because the
        // USDC balance has not moved.
        (uint256 equity,) = markEquity(vault);
        p.expectedLeverageX100 = equity == 0
            ? type(uint256).max
            : Math.mulDiv(p.expectedTotalNotional, 100, equity * ASSET_TO_E18);
        p.minAmountOut = limitPriceE18;
        p.orderHash = marketId == 0
            ? keccak256(abi.encode(vault, sizeDeltaE18, limitPriceE18))
            : keccak256(abi.encode(vault, marketId, sizeDeltaE18, limitPriceE18));
        p.marketId = marketId;
        p.resultingSizeE18 = resultingSize;
        p.limitPriceE18 = limitPriceE18;
        p.markPriceE18 = price;
    }

    function execute(address vault, bytes calldata order)
        external returns (int256 realizedPnl, uint256 amountOut)
    {
        if (msg.sender != vault) revert OnlyVault();
        (uint256 marketId, int256 sizeDeltaE18, uint256 limitPriceE18) = decodeOrder(order);
        amountOut = venue.tradeMarket(vault, marketId, sizeDeltaE18, limitPriceE18);
        realizedPnl = 0;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Takes the same fraction off every market the vault holds.
    function reduce(address vault, uint16 fractionBps)
        external returns (uint256 closedNotional, int256 realizedPnl)
    {
        if (msg.sender != vault) revert OnlyVault();
        if (fractionBps == 0 || fractionBps > 10_000) revert BadFraction();
        uint256 count = venue.marketCount();
        for (uint256 m; m < count; ++m) {
            (uint256 closed, int256 pnl) = _reduceMarket(vault, m, fractionBps);
            closedNotional += closed;
            realizedPnl += pnl;
        }
    }

    function _reduceMarket(address vault, uint256 marketId, uint16 fractionBps)
        private returns (uint256 closedNotional, int256 realizedPnl)
    {
        int256 size = venue.positionOf(vault, marketId);
        if (size == 0) return (0, 0);

        // Reduce-only by construction: the delta is a slice of the current size with
        // the opposite sign, so it can shrink the position but never flip or grow it.
        int256 sizeDelta = -(size * int256(uint256(fractionBps))) / 10_000;
        if (sizeDelta == 0) sizeDelta = size > 0 ? int256(-1) : int256(1);

        uint256 price = venue.priceOf(marketId);
        // Selling a long tolerates a lower fill; buying back a short tolerates a higher one.
        uint256 limitPrice = size > 0
            ? Math.mulDiv(price, 10_000 - MAX_UNWIND_SLIPPAGE_BPS, 10_000)
            : Math.mulDiv(price, 10_000 + MAX_UNWIND_SLIPPAGE_BPS, 10_000);

        // The venue keeps a cash-flow basis, so total PnL (open plus realised) is the
        // same before and after a close. Realised PnL for this step is the share of the
        // pre-trade unrealised PnL that the closed slice carried.
        int256 pnlBefore = venue.unrealizedPnlOf(vault, marketId);
        uint256 fillPrice = venue.tradeMarket(vault, marketId, sizeDelta, limitPrice);
        closedNotional = Math.mulDiv(_abs(sizeDelta), fillPrice, 1e18);
        realizedPnl = (pnlBefore * int256(_abs(sizeDelta))) / int256(_abs(size));
    }

    function positionState(address vault)
        external view returns (uint256 positionNotional, uint256 totalNotional)
    {
        uint256 count = venue.marketCount();
        for (uint256 m; m < count; ++m) {
            uint256 notional = Math.mulDiv(_abs(venue.positionOf(vault, m)), venue.priceOf(m), 1e18);
            if (notional > positionNotional) positionNotional = notional;
            totalNotional += notional;
        }
    }

    /// @inheritdoc IVenueAdapter
    /// @dev `markedAt` is the oldest timestamp among the markets the vault holds, so one
    ///      stale market makes the whole mark stale. A flat vault is marked by market 0.
    function markEquity(address vault) public view returns (uint256 equity, uint256 markedAt) {
        uint256 cash = IMandateVaultView(vault).totalAssets();
        int256 equityE18 = int256(cash * ASSET_TO_E18);
        uint256 count = venue.marketCount();
        for (uint256 m; m < count; ++m) {
            if (venue.positionOf(vault, m) == 0 && venue.costOf(vault, m) == 0) continue;
            equityE18 += venue.unrealizedPnlOf(vault, m);
            if (venue.positionOf(vault, m) != 0) {
                uint256 at = venue.updatedAtOf(m);
                if (markedAt == 0 || at < markedAt) markedAt = at;
            }
        }
        if (markedAt == 0) markedAt = venue.updatedAtOf(0);
        equity = equityE18 <= 0 ? 0 : uint256(equityE18) / ASSET_TO_E18;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev The vault's reference market is market 0.
    function markPrice(address) external view returns (uint256 priceE18, uint256 markedAt) {
        return (venue.priceOf(0), venue.updatedAtOf(0));
    }

    /// @inheritdoc IVenueAdapter
    function marketPrice(uint256 marketId) external view returns (uint256 priceE18, uint256 markedAt) {
        return (venue.priceOf(marketId), venue.updatedAtOf(marketId));
    }

    function _abs(int256 value) private pure returns (uint256) {
        return value >= 0 ? uint256(value) : uint256(-value);
    }
}
