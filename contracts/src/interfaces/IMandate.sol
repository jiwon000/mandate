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
    /// @notice Reject any mark older than this many seconds. Must be in (0, MAX_MARK_AGE_CAP].
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

/// @notice Trading terms beyond the size and loss limits in RiskLimits.
/// @dev Kept in its own struct so RiskLimits, and every older configuration that
///      only sets it, keeps its layout. MandateRiskGuard.configure(vault, limits)
///      applies DEFAULT_TRADE_TERMS: market 0 only, both directions, everything
///      else off. A zero value turns a term off, except `allowedMarkets`, which
///      must name at least one market.
///      Pre-trade terms (`allowedMarkets`, `direction`, `maxPriceDeviationBps`,
///      `maxTradesPerDay`) make the guard revert the order. State terms
///      (`maxDailyLossBps`, `maxHoldingSeconds`) can be crossed with the agent doing
///      nothing, so crossing one lets anyone freeze the vault.
struct TradeTerms {
    /// @notice Bitmask of venue market ids the agent may trade; bit 0 is market 0.
    uint32 allowedMarkets;
    /// @notice 0 long and short, 1 long only, 2 short only. Checked on the position
    ///         an order leaves, so an order that only shrinks a position always passes.
    uint8 direction;
    /// @notice Largest distance between an order's limit price and the venue mark, in bps.
    uint16 maxPriceDeviationBps;
    /// @notice Orders that add exposure per UTC day. Orders that only take risk off are not counted.
    uint16 maxTradesPerDay;
    /// @notice Loss of NAV per share since the day's opening NAV, in bps.
    uint16 maxDailyLossBps;
    /// @notice Longest time the vault may go without being flat, in seconds.
    uint32 maxHoldingSeconds;
}

/// @notice A bound on how far the venue mark may sit from a second, independent price.
/// @dev Every other term trusts the venue mark: drawdown, leverage and the stress test
///      are all measured against it. A mark pushed away from the market (a thin book,
///      a stuck feed, a venue bug) would make those measures wrong in the same
///      direction at once. This term compares the mark with the adapter's reference
///      price (on Perpl, its oracle price) and refuses orders that add exposure while
///      the two disagree, or while the reference is older than its age limit. Orders
///      that only take risk off still pass, for the same reason as the stress test.
///      Kept out of RiskLimits and TradeTerms so neither layout, nor the termsHash of
///      a vault that does not set it, changes. All zero turns it off.
struct ReferenceTerms {
    /// @notice Largest distance between the venue mark and the reference price, in bps.
    uint16 maxMarkDeviationBps;
    /// @notice Oldest reference price the guard accepts, in seconds.
    uint32 maxReferenceAgeSeconds;
}

/// @notice A venue adapter that can quote a reference price next to its mark.
interface IReferencePriceSource {
    /// @notice The reference price for `marketId`, 1e18-scaled, and when it was set.
    function referencePrice(uint256 marketId) external view returns (uint256 priceE18, uint256 updatedAt);
}

/// @notice Fees the vault charges, as part of the locked terms.
/// @dev Charged by MandateVault by minting shares to the agent, never by moving
///      cash. The management fee accrues per second on marked equity while the vault
///      is Active and stops at a freeze. The performance fee is taken only on NAV per
///      share above the vault's fee high-water mark, so a vault below its best NAV
///      pays none.
struct FeeTerms {
    /// @notice Share of NAV gain above the fee high-water mark, in bps.
    uint16 performanceFeeBps;
    /// @notice Yearly rate on marked equity, in bps.
    uint16 managementFeeBps;
}

struct TradePreview {
    uint256 orderNotional;
    uint256 expectedPositionNotional;
    uint256 expectedTotalNotional;
    uint256 expectedLeverageX100;
    uint256 minAmountOut;
    bytes32 orderHash;
    /// @notice Venue market the order trades.
    uint256 marketId;
    /// @notice Signed position in `marketId` the order would leave, 1e18 units.
    int256 resultingSizeE18;
    /// @notice The order's own limit price, 1e18-scaled.
    uint256 limitPriceE18;
    /// @notice The venue's mark for `marketId` when the order was previewed.
    uint256 markPriceE18;
    /// @notice Signed position in `marketId` before the order, 1e18 units. With
    ///         `resultingSizeE18` it tells the guard when an order crosses through flat.
    int256 currentSizeE18;
}

interface IMandateVaultView {
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);

    /// @notice The one RiskGuard this vault actually trusts, fixed at construction.
    /// @dev MandateRegistry.registerAgent() reads this instead of taking a `guard`
    ///      argument, so a caller cannot point registration at a fake guard that
    ///      just answers every check with "yes" (2026-10-04 security review).
    function riskGuard() external view returns (IRiskGuard);

    /// @notice Cash plus unrealised PnL, with the venue's timestamp for the mark.
    function markedAssets() external view returns (uint256 assets, uint256 markedAt);

    /// @notice The one account allowed to trade the vault, fixed at construction.
    function agent() external view returns (address);

    /// @notice The one venue adapter the vault trades and is priced through, fixed at construction.
    function venueAdapter() external view returns (address);

    /// @notice 0 Active, 1 Frozen, 2 Closed (MandateVault.AgentState).
    function state() external view returns (uint8);
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

    /// @notice The venue's mark for one market, 1e18-scaled, with its timestamp.
    /// @dev A guard whose terms allow a single market builds its volatility estimate
    ///      from that market's series.
    function marketPrice(uint256 marketId) external view returns (uint256 priceE18, uint256 markedAt);
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

    /// @notice The day's opening NAV per share and the last NAV per share the guard
    ///         marked, both 1e18-scaled; zero before the first mark.
    function dayOf(address vault) external view returns (uint64 day, uint128 openNav, uint128 lastNav);

    /// @notice True once the vault's limits and adapter allowlist can no longer change.
    function termsLocked(address vault) external view returns (bool);

    /// @notice keccak256(abi.encode(limits, tradeTerms, fees)) of the vault's configured
    ///         terms, with the ReferenceTerms appended to the encoding when they are set.
    /// @dev What MandateRegistry.registerAgent() checks a caller's claimed terms
    ///      against, so a registry entry cannot disagree with the real terms.
    function termsHash(address vault) external view returns (bytes32);

    /// @notice The vault's ReferenceTerms; all zero when the term is off.
    function referenceTermsOf(address vault) external view returns (ReferenceTerms memory);

    /// @notice The vault's TradeTerms, as configured.
    function tradeTermsOf(address vault) external view returns (TradeTerms memory);

    /// @notice The fees the vault charges, as configured.
    function feesOf(address vault) external view returns (FeeTerms memory);

    /// @notice Tell the guard the vault minted fee shares, so the NAV marks it keeps
    ///         are restated per share and a fee is never read as a trading loss.
    function onFeeMint(uint256 supplyBefore, uint256 supplyAfter) external;

    /// @notice True if `adapter` may be used to trade `vault`.
    function adapterAllowed(address vault, address adapter) external view returns (bool);

    /// @notice Why and when this guard froze `vault`: reason 0 none, 1 drawdown past
    ///         the cap, 2 no fresh mark for UNOBSERVABLE_MARK_AGES times the mark age,
    ///         3 daily loss past the cap, 4 held a position past the holding limit.
    function freezeOf(address vault) external view returns (uint8 reason, uint64 frozenAt);
}
