// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVenueAdapter, IMandateVaultView, TradePreview} from "./interfaces/IMandate.sol";
import {DeterministicMockVenue} from "./mocks/DeterministicMockVenue.sol";

contract MockVenueAdapter is IVenueAdapter {
    error OnlyVault();
    error ZeroOrder();
    error PreviewMismatch();

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
        uint256 assets = IMandateVaultView(vault).totalAssets();
        p.expectedLeverageX100 = assets == 0
            ? type(uint256).max
            : Math.mulDiv(p.expectedTotalNotional, 100, assets * 1e12);
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

    function positionState(address vault)
        external view returns (uint256 positionNotional, uint256 totalNotional)
    {
        positionNotional = Math.mulDiv(_abs(venue.positionSizeE18(vault)), venue.priceE18(), 1e18);
        totalNotional = positionNotional;
    }

    function _abs(int256 value) private pure returns (uint256) {
        return value >= 0 ? uint256(value) : uint256(-value);
    }
}
