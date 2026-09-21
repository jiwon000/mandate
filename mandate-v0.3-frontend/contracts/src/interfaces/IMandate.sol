// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct RiskLimits {
    uint16 maxLeverageX100;
    uint16 maxRealizedDrawdownBps;
    uint16 maxSlippageBps;
    uint32 minBlocksBetweenTrades;
    uint8 maxConsecutiveRejects;
    uint256 maxOrderNotional;
    uint256 maxPositionNotional;
    uint256 maxTotalNotional;
    uint256 maxBlockNotional;
}

struct TradePreview {
    uint256 orderNotional;
    uint256 expectedPositionNotional;
    uint256 expectedTotalNotional;
    uint256 expectedLeverageX100;
    uint256 minAmountOut;
    bytes32 orderHash;
}

interface IMandateVaultView {
    function totalAssets() external view returns (uint256);
}

interface IVenueAdapter {
    function preview(address vault, bytes calldata order) external view returns (TradePreview memory);
    function execute(address vault, bytes calldata order)
        external returns (int256 realizedPnl, uint256 amountOut);
    function positionState(address vault)
        external view returns (uint256 positionNotional, uint256 totalNotional);
}

interface IRiskGuard {
    function checkAndConsumeBefore(
        address vault,
        address adapter,
        TradePreview calldata trade
    ) external;
}
