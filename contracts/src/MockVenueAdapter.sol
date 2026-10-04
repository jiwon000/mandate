// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVenueAdapter, IMandateVaultView, TradePreview} from "./interfaces/IMandate.sol";
import {DeterministicMockVenue} from "./mocks/DeterministicMockVenue.sol";

contract MockVenueAdapter is IVenueAdapter {
    error OnlyVault();
    error ZeroOrder();
    error PreviewMismatch();
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

    function preview(address vault, bytes calldata order) public view returns (TradePreview memory p) {
        (int256 sizeDeltaE18, uint256 limitPriceE18) = abi.decode(order, (int256, uint256));
        if (sizeDeltaE18 == 0) revert ZeroOrder();

        uint256 price = venue.priceE18();
        int256 resultingSize = venue.positionSizeE18(vault) + sizeDeltaE18;
        p.orderNotional = Math.mulDiv(_abs(sizeDeltaE18), price, 1e18);
        p.expectedPositionNotional = Math.mulDiv(_abs(resultingSize), price, 1e18);
        p.expectedTotalNotional = p.expectedPositionNotional;

        // Leverage is measured against mark equity, not the idle cash balance: an agent
        // sitting on an underwater position must not look under-levered just because the
        // USDC balance has not moved.
        (uint256 equity,) = markEquity(vault);
        p.expectedLeverageX100 = equity == 0
            ? type(uint256).max
            : Math.mulDiv(p.expectedTotalNotional, 100, equity * ASSET_TO_E18);
        p.minAmountOut = limitPriceE18;
        p.orderHash = keccak256(abi.encode(vault, sizeDeltaE18, limitPriceE18));
    }

    function execute(address vault, bytes calldata order)
        external returns (int256 realizedPnl, uint256 amountOut)
    {
        if (msg.sender != vault) revert OnlyVault();
        (int256 sizeDeltaE18, uint256 limitPriceE18) = abi.decode(order, (int256, uint256));
        amountOut = venue.trade(vault, sizeDeltaE18, limitPriceE18);
        realizedPnl = 0;
    }

    /// @inheritdoc IVenueAdapter
    function reduce(address vault, uint16 fractionBps)
        external returns (uint256 closedNotional, int256 realizedPnl)
    {
        if (msg.sender != vault) revert OnlyVault();
        if (fractionBps == 0 || fractionBps > 10_000) revert BadFraction();

        int256 size = venue.positionSizeE18(vault);
        if (size == 0) return (0, 0);

        // Reduce-only by construction: the delta is a slice of the current size with
        // the opposite sign, so it can shrink the position but never flip or grow it.
        int256 sizeDelta = -(size * int256(uint256(fractionBps))) / 10_000;
        if (sizeDelta == 0) sizeDelta = size > 0 ? int256(-1) : int256(1);

        uint256 price = venue.priceE18();
        // Selling a long tolerates a lower fill; buying back a short tolerates a higher one.
        uint256 limitPrice = size > 0
            ? Math.mulDiv(price, 10_000 - MAX_UNWIND_SLIPPAGE_BPS, 10_000)
            : Math.mulDiv(price, 10_000 + MAX_UNWIND_SLIPPAGE_BPS, 10_000);

        // The venue keeps a cash-flow basis, so total PnL (open plus realised) is the
        // same before and after a close. Realised PnL for this step is the share of the
        // pre-trade unrealised PnL that the closed slice carried.
        int256 pnlBefore = venue.unrealizedPnlE18(vault);
        uint256 fillPrice = venue.trade(vault, sizeDelta, limitPrice);
        closedNotional = Math.mulDiv(_abs(sizeDelta), fillPrice, 1e18);
        realizedPnl = (pnlBefore * int256(_abs(sizeDelta))) / int256(_abs(size));
    }

    function positionState(address vault)
        external view returns (uint256 positionNotional, uint256 totalNotional)
    {
        positionNotional = Math.mulDiv(_abs(venue.positionSizeE18(vault)), venue.priceE18(), 1e18);
        totalNotional = positionNotional;
    }

    /// @inheritdoc IVenueAdapter
    function markEquity(address vault) public view returns (uint256 equity, uint256 markedAt) {
        uint256 cash = IMandateVaultView(vault).totalAssets();
        int256 markValueE18 = (venue.positionSizeE18(vault) * int256(venue.priceE18())) / 1e18;
        int256 pnlE18 = markValueE18 - venue.netCostE18(vault);
        int256 equityE18 = int256(cash * ASSET_TO_E18) + pnlE18;
        equity = equityE18 <= 0 ? 0 : uint256(equityE18) / ASSET_TO_E18;
        markedAt = venue.updatedAt();
    }

    function _abs(int256 value) private pure returns (uint256) {
        return value >= 0 ? uint256(value) : uint256(-value);
    }
}
