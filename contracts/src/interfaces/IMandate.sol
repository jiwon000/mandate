// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct RiskLimits {
    uint16 maxLeverageX100;
    /// @notice Mark-to-market drawdown cap, in bps of the high-water NAV per share.
    /// @dev Enforced by MandateRiskGuard._markAndCheck against the venue's mark price.
    ///      Named `maxDrawdownBps` (not `realized`) because it is now checked between
    ///      trades via poke(), not only when a position is closed.
    uint16 maxDrawdownBps;
    uint32 minBlocksBetweenTrades;
    /// @notice Reject any mark older than this many seconds. 0 disables the check.
    /// @dev This is the limit a slow chain cannot honour: a 2s cap is unreachable
    ///      when blocks are 12s apart, so the guard would revert every trade.
    uint32 maxMarkAgeSeconds;
    uint256 maxOrderNotional;
    uint256 maxPositionNotional;
    uint256 maxTotalNotional;
    uint256 maxBlockNotional;
    /// @notice Window of the guard's realised-volatility estimate, in seconds.
    ///         0 disables the estimate and the pre-trade stress check with it.
    /// @dev The guard keeps an exponentially weighted variance of the mark's return
    ///      per second, fed by every price it observes: observe(), poke() and trades.
    ///      Appended after the original eight fields so `termsHash` of an older
    ///      configuration is not silently re-ordered.
    uint32 volWindowSeconds;
    /// @notice Horizon of the stress move, in seconds: how long the position could sit
    ///         before anyone reacts to it. On a chain where poke() can land every
    ///         block this is short; it is the reaction time the allocator accepts.
    uint32 stressHorizonSeconds;
    /// @notice Size of the stress move in tenths of a sigma (30 = a 3-sigma move).
    uint16 stressSigmasX10;
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
    function totalSupply() external view returns (uint256);
}

interface IMandateVaultFreeze {
    function freeze(address beneficiary) external returns (uint256 bounty);
}

interface IVenueAdapter {
    function preview(address vault, bytes calldata order) external view returns (TradePreview memory);
    function execute(address vault, bytes calldata order)
        external returns (int256 realizedPnl, uint256 amountOut);
    function positionState(address vault)
        external view returns (uint256 positionNotional, uint256 totalNotional);

    /// @notice Close `fractionBps` of the vault's open position at the venue, reduce-only.
    /// @dev Vault-only. The adapter derives the closing order from the position it can
    ///      see, so the caller never has to know the venue's units or direction. Fills
    ///      worse than the adapter's slippage bound against the current mark revert.
    ///      `closedNotional` is what came off the book at the fill price.
    function reduce(address vault, uint16 fractionBps)
        external returns (uint256 closedNotional, int256 realizedPnl);

    /// @notice Vault equity marked to the venue's current price, in asset decimals.
    /// @dev equity = idle asset balance + unrealised PnL on the open position.
    ///      `markedAt` is the venue's own price timestamp, not block.timestamp, so a
    ///      stale feed cannot be laundered into a fresh-looking mark by a fast chain.
    function markEquity(address vault) external view returns (uint256 equity, uint256 markedAt);

    /// @notice The venue's mark price for the market this vault trades, 1e18-scaled, with
    ///         the venue's own timestamp for it.
    /// @dev The guard's volatility estimate is built from this series. Equity would not
    ///      do: a flat vault's equity is constant whatever the market does.
    function markPrice(address vault) external view returns (uint256 priceE18, uint256 markedAt);
}

interface IRiskGuard {
    function checkAndConsumeBefore(
        address vault,
        address adapter,
        TradePreview calldata trade
    ) external;

    function checkAfter(address vault, address adapter) external;

    /// @notice Revert unless a mark taken at `markedAt` is still fresh enough to price against.
    function requireFreshMark(address vault, uint256 markedAt) external view;

    /// @notice True once the vault's limits and adapter allowlist can no longer change.
    function termsLocked(address vault) external view returns (bool);
}
