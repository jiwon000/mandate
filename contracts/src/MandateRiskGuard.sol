// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    IRiskGuard,
    IMandateVaultView,
    IMandateVaultFreeze,
    IVenueAdapter,
    RiskLimits,
    TradeTerms,
    FeeTerms,
    ReferenceTerms,
    IReferencePriceSource,
    TradePreview
} from "./interfaces/IMandate.sol";

contract MandateRiskGuard is IRiskGuard, Ownable {
    error OnlyVault();
    error AdapterNotAllowed();
    error OrderNotionalExceeded();
    error PositionNotionalExceeded();
    error TotalNotionalExceeded();
    error BlockNotionalExceeded();
    error LeverageExceeded();
    error CooldownActive();
    error LimitsNotConfigured();
    error MarkTooOld(uint256 markedAt, uint256 maxAge);
    error VaultNotActive();
    error LimitsLocked();
    /// @notice A window without a horizon or a sigma multiple would be a stress term
    ///         that never bites; refused at configure() so nobody reads it as one.
    error InvalidStressTerms();
    /// @notice Every mandate carries a loss cap and a mark age, each inside this
    ///         version's range. A vault with no cap would never freeze, and a cap is
    ///         only as tight as the age of the mark it is checked against.
    error InvalidLossTerms();
    /// @notice The vault's mark is not yet old enough to call it unobservable.
    error StillObservable(uint256 markedAt, uint256 unobservableAfter);
    error NothingToProtect();
    /// @notice poke() and observe() only read a vault through the adapter it trades on.
    error AdapterMismatch();
    /// @notice A k-sigma move over the stress horizon, applied to the exposure the order
    ///         would leave, would take the vault past `maxDrawdownBps`.
    error StressBreach(uint256 sigmaBps, uint256 moveBps, uint256 stressedDrawdownBps);
    /// @notice Trade terms outside this version's range: no market allowed, an unknown
    ///         direction mode, a bound past 100%, or a stress window on more than one market.
    error InvalidTradeTerms();
    /// @notice Fees above this version's caps.
    error InvalidFeeTerms();
    error OnlyOwnerOrFactory();
    error FactoryAlreadySet();
    error MarketNotAllowed(uint256 marketId);
    error DirectionNotAllowed(int256 resultingSizeE18);
    error PriceDeviationExceeded(uint256 deviationBps);
    error DailyTradesExceeded();
    /// @dev Reference terms out of range: a deviation above 10,000 bps, or an age that
    ///      is zero or above MAX_MARK_AGE_CAP while the deviation bound is set.
    error InvalidReferenceTerms();
    /// @dev The vault's adapter cannot quote a reference price for the vault's market.
    error NoReferencePrice(address adapter);
    error MarkDeviationExceeded(uint256 deviationBps);
    error ReferenceTooOld(uint256 updatedAt, uint256 maxAge);
    /// @notice Today's loss is past `maxDailyLossBps`: orders that add risk wait for
    ///         the next UTC day. Orders that take risk off still go through.
    error DailyLossPaused(uint256 resumesAt);
    /// @notice Only a vault frozen for having no fresh mark can be resumed.
    error NotResumable();
    /// @notice The fresh mark shows a limit breached, so the vault stays frozen.
    error StillBreached();

    /// @dev NAV per share is scaled so a freshly funded vault starts at exactly 1e18.
    uint256 private constant ONE = 1e18;

    /// @notice Upper bound on `maxDrawdownBps` in this guard version. Past half the
    ///         capital a cap no longer reads as a loss bound.
    uint16 public constant MAX_DRAWDOWN_BPS_CAP = 5_000;
    /// @notice Upper bound on `maxMarkAgeSeconds` in this guard version.
    uint32 public constant MAX_MARK_AGE_CAP = 60;
    /// @notice A vault whose mark is older than this many mark ages can be frozen by
    ///         anyone. One late update is noise; three in a row means no feed.
    uint256 public constant UNOBSERVABLE_MARK_AGES = 3;
    /// @notice After an unobservable freeze, unwind() waits this long. If the feed comes
    ///         back inside it and every limit holds, anyone can resume() the vault.
    uint256 public constant UNOBSERVABLE_RECOVERY = 15 minutes;

    /// @notice Yearly management fee cap, in bps.
    uint16 public constant MAX_MANAGEMENT_FEE_BPS = 500;
    /// @notice Performance fee cap, in bps of gain above the fee high-water mark.
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 3_000;
    /// @notice TradeTerms.direction values; 0 allows both.
    uint8 public constant DIRECTION_LONG_ONLY = 1;
    uint8 public constant DIRECTION_SHORT_ONLY = 2;

    uint8 private constant REASON_DRAWDOWN = 1;
    uint8 private constant REASON_UNOBSERVABLE = 2;
    uint8 private constant REASON_HOLDING_TIME = 4;

    struct BlockUsage {
        uint64 blockNumber;
        uint192 notional;
    }

    struct FreezeRecord {
        uint8 reason;
        uint64 frozenAt;
    }
    struct MarkState {
        uint128 highWaterNavPerShare;
    }

    /// @dev Daily-loss bookkeeping. `openNav` is the NAV per share the current UTC day
    ///      is measured from: the last NAV marked before the day began, so a loss that
    ///      lands across midnight is not forgiven by the date change.
    struct DayState {
        uint64 day;
        uint128 openNav;
        uint128 lastNav;
    }

    struct TradeCount {
        uint64 day;
        uint32 count;
    }

    /// @dev Realised-volatility state. `varRatePerSecond` is the exponentially weighted
    ///      variance of the mark's return per second, scaled by 1e36 (a return is
    ///      1e18-scaled, so its square is 1e36-scaled).
    struct VolState {
        uint128 lastPriceE18;
        uint64 lastPriceAt;
        uint128 varRatePerSecond;
    }

    /// @dev A return larger than this is capped before squaring. It keeps the arithmetic
    ///      in range; a 10x move in one observation is already off any drawdown scale.
    uint256 private constant MAX_RETURN = 10 * ONE;
    /// @dev Leverage above this is treated as this in the stress arithmetic.
    uint256 private constant MAX_STRESS_LEVERAGE_X100 = 1_000_000;

    mapping(address => RiskLimits) public limitsOf;
    mapping(address => bool) public configured;
    /// @notice Vaults whose terms are final. MandateVault refuses deposits until then.
    mapping(address => bool) public termsLocked;
    mapping(address => mapping(address => bool)) public adapterAllowed;
    mapping(address => BlockUsage) public blockUsageOf;
    mapping(address => uint256) public lastTradeBlock;
    mapping(address => MarkState) public markOf;
    mapping(address => VolState) public volOf;
    mapping(address => FreezeRecord) private freezeRecordOf;
    mapping(address => TradeTerms) private tradeTerms;
    mapping(address => FeeTerms) private fees;
    mapping(address => ReferenceTerms) private referenceTerms;
    mapping(address => DayState) public dayOf;
    mapping(address => TradeCount) public tradesOf;
    /// @notice When the vault last went from flat to holding a position; 0 while flat.
    mapping(address => uint64) public positionOpenedAt;
    /// @notice The UTC day (timestamp / 1 days) on which a mark last found the vault
    ///         past its daily loss cap. Adding risk is refused for the rest of that day.
    mapping(address => uint64) public pausedDayOf;

    /// @notice The one MandateFactory allowed to configure and lock vaults it deploys.
    ///         Set once by the owner.
    address public factory;

    event LimitsConfigured(address indexed vault);
    event FactorySet(address indexed factory);
    event DailyLossPause(address indexed vault, address indexed caller, uint256 navPerShare, uint256 lossBps, uint256 resumesAt);
    event Resumed(address indexed vault, address indexed caller, uint256 navPerShare);
    event HoldingTimeBreach(address indexed vault, address indexed caller, uint256 openedAt, uint256 bounty);
    event FeeRebased(address indexed vault, uint256 supplyBefore, uint256 supplyAfter);
    event ReferenceTermsSet(address indexed vault, uint16 maxMarkDeviationBps, uint32 maxReferenceAgeSeconds);
    event AdapterAllowed(address indexed vault, address indexed adapter, bool allowed);
    event TermsLocked(address indexed vault, bytes32 termsHash);
    event RiskConsumed(address indexed vault, bytes32 indexed orderHash, uint256 notional);
    event Marked(address indexed vault, uint256 navPerShare, uint256 highWaterNavPerShare, uint256 drawdownBps);
    event Unobservable(address indexed vault, address indexed caller, uint256 markedAt, uint256 bounty);
    event DrawdownBreach(
        address indexed vault,
        address indexed caller,
        uint256 navPerShare,
        uint256 drawdownBps,
        uint256 bounty
    );

    constructor() Ownable(msg.sender) {}

    modifier onlyOwnerOrFactory() {
        if (msg.sender != owner() && (factory == address(0) || msg.sender != factory)) {
            revert OnlyOwnerOrFactory();
        }
        _;
    }

    /// @notice Name the factory that may configure and lock the vaults it deploys. Once.
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Size and loss limits only, with the default trade terms (market 0, both
    ///         directions, nothing else) and no fees.
    function configure(address vault, RiskLimits calldata limits) external onlyOwnerOrFactory {
        _configure(vault, limits, TradeTerms(1, 0, 0, 0, 0, 0), FeeTerms(0, 0));
    }

    /// @notice Every term a mandate can carry.
    function configureTerms(
        address vault,
        RiskLimits calldata limits,
        TradeTerms calldata trade,
        FeeTerms calldata fee
    ) external onlyOwnerOrFactory {
        _configure(vault, limits, trade, fee);
    }

    function _configure(address vault, RiskLimits memory limits, TradeTerms memory trade, FeeTerms memory fee)
        private
    {
        if (termsLocked[vault]) revert LimitsLocked();
        if (
            limits.volWindowSeconds != 0 &&
            (limits.stressHorizonSeconds == 0 || limits.stressSigmasX10 == 0)
        ) revert InvalidStressTerms();
        if (
            limits.maxDrawdownBps == 0 || limits.maxDrawdownBps > MAX_DRAWDOWN_BPS_CAP ||
            limits.maxMarkAgeSeconds == 0 || limits.maxMarkAgeSeconds > MAX_MARK_AGE_CAP
        ) revert InvalidLossTerms();
        if (
            trade.allowedMarkets == 0 ||
            trade.direction > DIRECTION_SHORT_ONLY ||
            trade.maxPriceDeviationBps > 10_000 ||
            trade.maxDailyLossBps > MAX_DRAWDOWN_BPS_CAP ||
            // The volatility estimate is one price series, so a stress term needs a
            // single market to read it from.
            (limits.volWindowSeconds != 0 && (trade.allowedMarkets & (trade.allowedMarkets - 1)) != 0)
        ) revert InvalidTradeTerms();
        if (fee.managementFeeBps > MAX_MANAGEMENT_FEE_BPS || fee.performanceFeeBps > MAX_PERFORMANCE_FEE_BPS) {
            revert InvalidFeeTerms();
        }
        limitsOf[vault] = limits;
        tradeTerms[vault] = trade;
        fees[vault] = fee;
        configured[vault] = true;
        // Seed the high-water mark at par. Shares are minted 1:1 against the first
        // deposit, so NAV per share is 1e18 before any trade; without this seed the
        // first poke() after a loss would anchor the mark to the already-lost value.
        if (markOf[vault].highWaterNavPerShare == 0) {
            markOf[vault].highWaterNavPerShare = uint128(ONE);
        }
        if (dayOf[vault].openNav == 0) {
            dayOf[vault] = DayState(uint64(block.timestamp / 1 days), uint128(ONE), uint128(ONE));
        }
        emit LimitsConfigured(vault);
    }

    /// @notice Bound the venue mark against the adapter's reference price. Optional, and
    ///         like every other term it can only be set before the terms are locked.
    /// @dev The vault's own adapter must answer `referencePrice` with a set price for
    ///      every allowed market now; an adapter that cannot (MockVenueAdapter), or a
    ///      market whose oracle was never set, is refused here rather than at the first
    ///      order. Setting all zero clears the term.
    function setReferenceTerms(address vault, ReferenceTerms calldata r) external onlyOwnerOrFactory {
        if (termsLocked[vault]) revert LimitsLocked();
        if (!configured[vault]) revert LimitsNotConfigured();
        if (r.maxMarkDeviationBps == 0) {
            if (r.maxReferenceAgeSeconds != 0) revert InvalidReferenceTerms();
        } else {
            if (
                r.maxMarkDeviationBps > 10_000 ||
                r.maxReferenceAgeSeconds == 0 || r.maxReferenceAgeSeconds > MAX_MARK_AGE_CAP
            ) revert InvalidReferenceTerms();
            address adapter = IMandateVaultView(vault).venueAdapter();
            uint32 allowed = tradeTerms[vault].allowedMarkets;
            for (uint256 id; id < 32; ++id) {
                if ((allowed >> id) & 1 == 0) continue;
                try IReferencePriceSource(adapter).referencePrice(id) returns (uint256 price, uint256 updatedAt) {
                    if (price == 0 || updatedAt == 0) revert NoReferencePrice(adapter);
                } catch {
                    revert NoReferencePrice(adapter);
                }
            }
        }
        referenceTerms[vault] = r;
        emit ReferenceTermsSet(vault, r.maxMarkDeviationBps, r.maxReferenceAgeSeconds);
    }

    function setAdapter(address vault, address adapter, bool allowed) external onlyOwnerOrFactory {
        if (termsLocked[vault]) revert LimitsLocked();
        adapterAllowed[vault][adapter] = allowed;
        emit AdapterAllowed(vault, adapter, allowed);
    }

    /// @notice Make the vault's terms final. One way: after this neither the limits nor
    ///         the adapter allowlist can change, and a different mandate means a new vault.
    /// @dev The vault refuses deposits until this has happened, so an allocator never
    ///      funds terms the owner could still rewrite. `termsHash` is what a UI quotes
    ///      and what a registry release would anchor.
    function lockTerms(address vault) external onlyOwnerOrFactory {
        if (!configured[vault]) revert LimitsNotConfigured();
        if (termsLocked[vault]) revert LimitsLocked();
        termsLocked[vault] = true;
        emit TermsLocked(vault, termsHash(vault));
    }

    /// @notice keccak256(abi.encode(limits, tradeTerms, fees)): every term the vault runs
    ///         under. A vault with reference terms appends them to the encoding, so the
    ///         hash of a vault without them is unchanged.
    function termsHash(address vault) public view returns (bytes32) {
        ReferenceTerms memory r = referenceTerms[vault];
        if (r.maxMarkDeviationBps == 0) {
            return keccak256(abi.encode(limitsOf[vault], tradeTerms[vault], fees[vault]));
        }
        return keccak256(abi.encode(limitsOf[vault], tradeTerms[vault], fees[vault], r));
    }

    function referenceTermsOf(address vault) external view returns (ReferenceTerms memory) {
        return referenceTerms[vault];
    }

    /// @notice The venue mark, the reference price, the reference's timestamp and the
    ///         distance between the two in bps, for the vault's market, as the order
    ///         check would read them now. Reverts if the adapter has no reference price.
    function referenceQuote(address vault)
        external
        view
        returns (uint256 markE18, uint256 referenceE18, uint256 updatedAt, uint256 deviationBps)
    {
        IVenueAdapter adapter = IVenueAdapter(IMandateVaultView(vault).venueAdapter());
        uint256 marketId = _referenceMarket(tradeTerms[vault].allowedMarkets);
        (markE18,) = adapter.marketPrice(marketId);
        (referenceE18, updatedAt) = IReferencePriceSource(address(adapter)).referencePrice(marketId);
        deviationBps = _deviationBps(markE18, referenceE18);
    }

    /// @inheritdoc IRiskGuard
    function tradeTermsOf(address vault) external view returns (TradeTerms memory) {
        return tradeTerms[vault];
    }

    /// @inheritdoc IRiskGuard
    function feesOf(address vault) external view returns (FeeTerms memory) {
        return fees[vault];
    }

    /// @inheritdoc IRiskGuard
    /// @dev Fee shares lower NAV per share by exactly the fee. Restating the marks
    ///      per share keeps that out of the drawdown and daily-loss measures: those
    ///      bound what trading did to the vault, and the fee is a declared term.
    function onFeeMint(uint256 supplyBefore, uint256 supplyAfter) external {
        address vault = msg.sender;
        if (!configured[vault]) revert OnlyVault();
        if (supplyAfter <= supplyBefore || supplyBefore == 0) return;
        MarkState storage mark = markOf[vault];
        mark.highWaterNavPerShare = uint128(Math.mulDiv(mark.highWaterNavPerShare, supplyBefore, supplyAfter));
        DayState storage d = dayOf[vault];
        d.openNav = uint128(Math.mulDiv(d.openNav, supplyBefore, supplyAfter));
        d.lastNav = uint128(Math.mulDiv(d.lastNav, supplyBefore, supplyAfter));
        emit FeeRebased(vault, supplyBefore, supplyAfter);
    }

    function checkAndConsumeBefore(
        address vault,
        address adapter,
        TradePreview calldata trade
    ) external {
        if (msg.sender != vault) revert OnlyVault();
        if (!configured[vault]) revert LimitsNotConfigured();
        if (!adapterAllowed[vault][adapter]) revert AdapterNotAllowed();

        RiskLimits memory limits = limitsOf[vault];
        // Fold the current mark into the volatility estimate before judging the order,
        // so a shock that landed since the last observation counts against it.
        VolState memory vol = _observePrice(vault, adapter, limits);

        // An order adds risk when it grows total exposure, and also when it crosses
        // through flat: the size on the new side is a fresh position opened at this mark,
        // even if it is no larger than the one it replaced.
        (, uint256 totalNotional) = IVenueAdapter(adapter).positionState(vault);
        bool addsRisk = trade.expectedTotalNotional > totalNotional ||
            (trade.currentSizeE18 > 0 && trade.resultingSizeE18 < 0) ||
            (trade.currentSizeE18 < 0 && trade.resultingSizeE18 > 0);

        if (trade.orderNotional > limits.maxOrderNotional) revert OrderNotionalExceeded();
        // A price move can carry a position past its caps without any trade. Holding the
        // order that shrinks it to the same caps would leave the agent able to get out
        // only in one piece, so the three exposure caps bind orders that add risk.
        if (addsRisk) {
            if (trade.expectedPositionNotional > limits.maxPositionNotional) revert PositionNotionalExceeded();
            if (trade.expectedTotalNotional > limits.maxTotalNotional) revert TotalNotionalExceeded();
            if (trade.expectedLeverageX100 > limits.maxLeverageX100) revert LeverageExceeded();
        }
        _checkTradeTerms(vault, trade, addsRisk);
        if (addsRisk) {
            _checkReference(vault, adapter, trade);
            _checkDailyLoss(vault, adapter);
        }

        // Pre-trade stress test, only for orders that add exposure. An order that takes
        // risk off is never refused here, whatever the market is doing: in a spike the
        // guard wants the agent to be able to get smaller, not to be stuck.
        if (limits.volWindowSeconds != 0 && addsRisk) {
            (uint256 sigmaBps, uint256 moveBps, uint256 stressedDrawdownBps) =
                _stress(vault, adapter, limits, vol, trade.expectedLeverageX100);
            if (stressedDrawdownBps > limits.maxDrawdownBps) {
                revert StressBreach(sigmaBps, moveBps, stressedDrawdownBps);
            }
        }
        if (
            lastTradeBlock[vault] != 0 &&
            block.number < lastTradeBlock[vault] + limits.minBlocksBetweenTrades
        ) revert CooldownActive();

        BlockUsage memory usage = blockUsageOf[vault];
        uint256 used = usage.blockNumber == block.number ? usage.notional : 0;
        uint256 next = used + trade.orderNotional;
        if (next > limits.maxBlockNotional || next > type(uint192).max) {
            revert BlockNotionalExceeded();
        }

        blockUsageOf[vault] = BlockUsage(uint64(block.number), uint192(next));
        lastTradeBlock[vault] = block.number;
        emit RiskConsumed(vault, trade.orderHash, trade.orderNotional);
    }

    /// @dev Market allowlist, direction, limit-price distance from the mark, and the
    ///      daily count of orders that add exposure. Orders that only take risk off are
    ///      not counted, so hitting the count never traps the agent in a position.
    function _checkTradeTerms(address vault, TradePreview calldata trade, bool addsRisk) private {
        TradeTerms memory t = tradeTerms[vault];
        if (trade.marketId >= 32 || (t.allowedMarkets >> trade.marketId) & 1 == 0) {
            revert MarketNotAllowed(trade.marketId);
        }
        if (
            (t.direction == DIRECTION_LONG_ONLY && trade.resultingSizeE18 < 0) ||
            (t.direction == DIRECTION_SHORT_ONLY && trade.resultingSizeE18 > 0)
        ) revert DirectionNotAllowed(trade.resultingSizeE18);
        if (t.maxPriceDeviationBps != 0) {
            uint256 mark = trade.markPriceE18;
            uint256 limit = trade.limitPriceE18;
            uint256 diff = limit > mark ? limit - mark : mark - limit;
            uint256 deviationBps = mark == 0 ? type(uint256).max : Math.mulDiv(diff, 10_000, mark);
            if (deviationBps > t.maxPriceDeviationBps) revert PriceDeviationExceeded(deviationBps);
        }
        if (t.maxTradesPerDay != 0 && addsRisk) {
            uint64 today = uint64(block.timestamp / 1 days);
            TradeCount memory c = tradesOf[vault];
            uint32 count = c.day == today ? c.count : 0;
            if (count >= t.maxTradesPerDay) revert DailyTradesExceeded();
            tradesOf[vault] = TradeCount(today, count + 1);
        }
    }

    /// @dev Exposure-adding orders only, as with the stress test: when the mark cannot
    ///      be trusted the agent should still be able to get smaller. An adapter without
    ///      a reference price makes this revert, so the term fails closed.
    function _checkReference(address vault, address adapter, TradePreview calldata trade) private view {
        ReferenceTerms memory r = referenceTerms[vault];
        if (r.maxMarkDeviationBps == 0) return;
        (uint256 ref, uint256 updatedAt) = IReferencePriceSource(adapter).referencePrice(trade.marketId);
        if (block.timestamp > updatedAt + r.maxReferenceAgeSeconds) {
            revert ReferenceTooOld(updatedAt, r.maxReferenceAgeSeconds);
        }
        uint256 deviationBps = _deviationBps(trade.markPriceE18, ref);
        if (deviationBps > r.maxMarkDeviationBps) revert MarkDeviationExceeded(deviationBps);
    }

    /// @dev The first of three tiers. A daily loss past the cap pauses new risk until the
    ///      next UTC day; the position stays with the agent, who can still take it off.
    ///      Checked against the current mark as well as the stored pause, so a loss no
    ///      mark has recorded yet still stops the order.
    function _checkDailyLoss(address vault, address adapter) private view {
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 cap = tradeTerms[vault].maxDailyLossBps;
        if (pausedDayOf[vault] == today || (cap != 0 && _loss(vault, adapter) > cap)) {
            revert DailyLossPaused((uint256(today) + 1) * 1 days);
        }
    }

    function _loss(address vault, address adapter) private view returns (uint256 lossBps) {
        (lossBps,) = dailyLossQuote(vault, adapter);
    }

    /// @dev Distance of `price` from `ref` in bps of `ref`; no reference reads as infinitely far.
    function _deviationBps(uint256 price, uint256 ref) private pure returns (uint256) {
        if (ref == 0) return type(uint256).max;
        uint256 diff = price > ref ? price - ref : ref - price;
        return Math.mulDiv(diff, 10_000, ref);
    }

    /// @notice Re-mark a vault and freeze it if the drawdown limit is breached.
    /// @dev Permissionless and bountied. This is the half of the guarantee that does not
    ///      depend on the agent choosing to trade: an agent that opens a levered position
    ///      and then goes quiet is never checked by checkAndConsumeBefore alone.
    ///      Enforcement precision is bounded by how often this can run, which is bounded
    ///      by the block time.
    ///      `adapter` must be the vault's own: a second allowlisted adapter would mark
    ///      the vault off a book that is not the one its shares are priced on.
    function poke(address vault, address adapter) external returns (bool frozen) {
        if (!configured[vault]) revert LimitsNotConfigured();
        if (!adapterAllowed[vault][adapter]) revert AdapterNotAllowed();
        if (adapter != IMandateVaultView(vault).venueAdapter()) revert AdapterMismatch();
        return _markAndCheck(vault, adapter, msg.sender);
    }

    /// @notice Freeze a vault nobody can check any more: its mark is older than
    ///         UNOBSERVABLE_MARK_AGES times its `maxMarkAgeSeconds`. Permissionless and
    ///         bountied like poke().
    /// @dev poke() reverts with MarkTooOld once the feed stops, so without this a
    ///      vault whose venue goes quiet stays Active with an open position and no
    ///      check on it. If the guarantee cannot be verified, new risk stops. The
    ///      mark is the vault's own markedAssets(), the one its shares are priced
    ///      off, so a caller cannot point this at a different adapter. An unfunded
    ///      vault has nothing to protect and is left alone, so a vault cannot be
    ///      bricked between deployment and its first deposit.
    function freezeUnobservable(address vault) external returns (uint256 bounty) {
        if (!configured[vault]) revert LimitsNotConfigured();
        if (IMandateVaultView(vault).totalSupply() == 0) revert NothingToProtect();
        // A venue that cannot be read at all has no mark: that is the case this exists for.
        uint256 markedAt;
        try IMandateVaultView(vault).markedAssets() returns (uint256, uint256 at) {
            markedAt = at;
        } catch {}
        uint256 after_ = markedAt + uint256(limitsOf[vault].maxMarkAgeSeconds) * UNOBSERVABLE_MARK_AGES;
        if (block.timestamp <= after_) revert StillObservable(markedAt, after_);
        bounty = _freeze(vault, REASON_UNOBSERVABLE, msg.sender);
        emit Unobservable(vault, msg.sender, markedAt, bounty);
    }

    /// @inheritdoc IRiskGuard
    function freezeOf(address vault) external view returns (uint8 reason, uint64 frozenAt) {
        FreezeRecord memory record = freezeRecordOf[vault];
        return (record.reason, record.frozenAt);
    }

    /// @inheritdoc IRiskGuard
    function unwindAllowedAt(address vault) external view returns (uint256) {
        FreezeRecord memory record = freezeRecordOf[vault];
        if (record.reason != REASON_UNOBSERVABLE) return 0;
        return uint256(record.frozenAt) + UNOBSERVABLE_RECOVERY;
    }

    /// @notice Put a vault frozen for having no fresh mark back to work once it has one.
    /// @dev The second tier. An unobservable freeze says nothing about the agent: the
    ///      feed stopped. So it leaves UNOBSERVABLE_RECOVERY before unwind() may start,
    ///      and inside it anyone may call this. It re-marks against the vault's own
    ///      adapter and reverts unless every limit holds on that mark, measured from the
    ///      same high-water mark as before: the terms do not reset. Drawdown and holding
    ///      time freezes are the third tier and never come back; the agent's own record
    ///      broke the terms, and different terms mean a new vault.
    function resume(address vault) external {
        if (freezeRecordOf[vault].reason != REASON_UNOBSERVABLE || IMandateVaultView(vault).state() != 1) {
            revert NotResumable();
        }
        address adapter = IMandateVaultView(vault).venueAdapter();
        IMandateVaultFreeze(vault).resume();
        if (_markAndCheck(vault, adapter, address(0))) revert StillBreached();
        (uint256 equity,) = IVenueAdapter(adapter).markEquity(vault);
        uint256 supply = IMandateVaultView(vault).totalSupply();
        emit Resumed(vault, msg.sender, supply == 0 ? ONE : Math.mulDiv(equity, ONE, supply));
    }

    /// @notice Feed the current mark into the vault's volatility estimate. Permissionless
    ///         and free of side effects on the vault: no mark, no freeze, no bounty.
    /// @dev poke() and every trade observe as well; this is for a keeper that wants the
    ///      estimate sampled on a steady cadence between them. The price itself comes
    ///      from the adapter, so a caller controls when the series is sampled, not what
    ///      it says.
    function observe(address vault, address adapter) external {
        if (!configured[vault]) revert LimitsNotConfigured();
        if (!adapterAllowed[vault][adapter]) revert AdapterNotAllowed();
        if (adapter != IMandateVaultView(vault).venueAdapter()) revert AdapterMismatch();
        _observePrice(vault, adapter, limitsOf[vault]);
    }

    /// @inheritdoc IRiskGuard
    function checkAfter(address vault, address adapter) external {
        if (msg.sender != vault) revert OnlyVault();
        if (!configured[vault]) revert LimitsNotConfigured();
        (, uint256 totalNotional) = IVenueAdapter(adapter).positionState(vault);
        if (totalNotional == 0) {
            positionOpenedAt[vault] = 0;
        } else if (positionOpenedAt[vault] == 0) {
            positionOpenedAt[vault] = uint64(block.timestamp);
        }
        _markAndCheck(vault, adapter, address(0));
    }

    /// @inheritdoc IRiskGuard
    /// @dev The vault prices allocate() and withdraw() off the same mark this guard
    ///      enforces on trades, so "too old to trade against" and "too old to price
    ///      against" stay one definition instead of drifting into two.
    function requireFreshMark(address vault, uint256 markedAt) external view {
        uint32 maxAge = limitsOf[vault].maxMarkAgeSeconds;
        if (maxAge != 0 && block.timestamp > markedAt + maxAge) {
            revert MarkTooOld(markedAt, maxAge);
        }
    }

    /// @notice Current NAV per share and drawdown without writing state.
    function quote(address vault, address adapter)
        external
        view
        returns (uint256 navPerShare, uint256 highWaterNavPerShare, uint256 drawdownBps, uint256 markedAt)
    {
        uint256 equity;
        (equity, markedAt) = IVenueAdapter(adapter).markEquity(vault);
        uint256 supply = IMandateVaultView(vault).totalSupply();
        highWaterNavPerShare = markOf[vault].highWaterNavPerShare;
        if (supply == 0) return (ONE, highWaterNavPerShare, 0, markedAt);
        navPerShare = Math.mulDiv(equity, ONE, supply);
        drawdownBps = _drawdownBps(navPerShare, highWaterNavPerShare);
    }

    /// @notice The stress numbers checkAndConsumeBefore would use right now for a vault
    ///         levered `leverageX100` after the order: sigma over the stress horizon, the
    ///         k-sigma move, and the drawdown that move would leave. Folds in the current
    ///         mark without writing it, so the view and the check agree.
    function stressQuote(address vault, address adapter, uint256 leverageX100)
        external
        view
        returns (uint256 sigmaBps, uint256 moveBps, uint256 stressedDrawdownBps)
    {
        RiskLimits memory limits = limitsOf[vault];
        if (limits.volWindowSeconds == 0) return (0, 0, 0);
        (VolState memory vol,) = _projectVol(vault, adapter, limits);
        return _stress(vault, adapter, limits, vol, leverageX100);
    }

    function _markAndCheck(address vault, address adapter, address beneficiary)
        internal
        returns (bool frozen)
    {
        RiskLimits memory limits = limitsOf[vault];
        (uint256 equity, uint256 markedAt) = IVenueAdapter(adapter).markEquity(vault);

        if (block.timestamp > markedAt + limits.maxMarkAgeSeconds) {
            revert MarkTooOld(markedAt, limits.maxMarkAgeSeconds);
        }

        _observePrice(vault, adapter, limits);

        uint256 supply = IMandateVaultView(vault).totalSupply();
        if (supply == 0) return false;

        uint256 navPerShare = Math.mulDiv(equity, ONE, supply);
        MarkState storage mark = markOf[vault];
        if (navPerShare > mark.highWaterNavPerShare) {
            mark.highWaterNavPerShare = uint128(navPerShare);
        }
        uint256 drawdownBps = _drawdownBps(navPerShare, mark.highWaterNavPerShare);
        emit Marked(vault, navPerShare, mark.highWaterNavPerShare, drawdownBps);
        uint256 dailyLossBps = _markDay(vault, navPerShare);

        if (drawdownBps > limits.maxDrawdownBps) {
            uint256 bounty = _freeze(vault, REASON_DRAWDOWN, beneficiary);
            emit DrawdownBreach(vault, beneficiary, navPerShare, drawdownBps, bounty);
            return true;
        }
        TradeTerms memory t = tradeTerms[vault];
        if (t.maxDailyLossBps != 0 && dailyLossBps > t.maxDailyLossBps) {
            _pauseForDay(vault, beneficiary, navPerShare, dailyLossBps);
        }
        uint64 openedAt = positionOpenedAt[vault];
        if (t.maxHoldingSeconds != 0 && openedAt != 0 && block.timestamp > uint256(openedAt) + t.maxHoldingSeconds) {
            uint256 bounty = _freeze(vault, REASON_HOLDING_TIME, beneficiary);
            emit HoldingTimeBreach(vault, beneficiary, openedAt, bounty);
            return true;
        }
        return false;
    }

    function _pauseForDay(address vault, address caller, uint256 navPerShare, uint256 lossBps) private {
        uint64 today = uint64(block.timestamp / 1 days);
        if (pausedDayOf[vault] == today) return;
        pausedDayOf[vault] = today;
        emit DailyLossPause(vault, caller, navPerShare, lossBps, (uint256(today) + 1) * 1 days);
    }

    function _freeze(address vault, uint8 reason, address beneficiary) private returns (uint256) {
        freezeRecordOf[vault] = FreezeRecord(reason, uint64(block.timestamp));
        return IMandateVaultFreeze(vault).freeze(beneficiary);
    }

    /// @dev Roll the day if it changed and return today's loss from its opening NAV.
    function _markDay(address vault, uint256 navPerShare) private returns (uint256 lossBps) {
        DayState memory d = dayOf[vault];
        uint64 today = uint64(block.timestamp / 1 days);
        if (d.day != today) {
            d.openNav = d.lastNav == 0 ? uint128(navPerShare) : d.lastNav;
            d.day = today;
        }
        d.lastNav = uint128(navPerShare);
        dayOf[vault] = d;
        return _drawdownBps(navPerShare, d.openNav);
    }

    /// @notice Today's loss from the day's opening NAV, in bps, at the current mark.
    function dailyLossQuote(address vault, address adapter) public view returns (uint256 lossBps, uint256 openNav) {
        (uint256 equity,) = IVenueAdapter(adapter).markEquity(vault);
        uint256 supply = IMandateVaultView(vault).totalSupply();
        DayState memory d = dayOf[vault];
        openNav = d.day == uint64(block.timestamp / 1 days) || d.lastNav == 0 ? d.openNav : d.lastNav;
        if (supply == 0 || openNav == 0) return (0, openNav);
        lossBps = _drawdownBps(Math.mulDiv(equity, ONE, supply), openNav);
    }

    /// @dev Write the projected volatility state if the mark moved on. A vault without a
    ///      window never touches this storage, so the term costs nothing where it is off.
    function _observePrice(address vault, address adapter, RiskLimits memory limits)
        private
        returns (VolState memory vol)
    {
        if (limits.volWindowSeconds == 0) return vol;
        bool changed;
        (vol, changed) = _projectVol(vault, adapter, limits);
        if (changed) volOf[vault] = vol;
    }

    /// @dev The volatility state after folding in the adapter's current mark. Nothing is
    ///      written. A mark no newer than the last one observed changes nothing.
    ///
    ///      The estimate is a time-weighted EWMA of squared returns per second:
    ///          v' = (window * v + r^2) / (window + dt)
    ///      where r is the return since the last observation and dt the seconds between
    ///      them. Dividing by dt inside the weight normalises for uneven sampling, so a
    ///      2% move over 10 seconds counts for ten times the variance rate of the same
    ///      move over 100 seconds. The first observation only seeds the price.
    function _projectVol(address vault, address adapter, RiskLimits memory limits)
        private
        view
        returns (VolState memory vol, bool changed)
    {
        vol = volOf[vault];
        (uint256 priceE18, uint256 markedAt) =
            IVenueAdapter(adapter).marketPrice(_referenceMarket(tradeTerms[vault].allowedMarkets));
        if (priceE18 == 0 || markedAt <= vol.lastPriceAt) return (vol, false);
        if (priceE18 > type(uint128).max) priceE18 = type(uint128).max;

        if (vol.lastPriceAt != 0) {
            uint256 last = vol.lastPriceE18;
            uint256 diff = priceE18 > last ? priceE18 - last : last - priceE18;
            uint256 r = Math.mulDiv(diff, ONE, last);
            if (r > MAX_RETURN) r = MAX_RETURN;
            uint256 dt = markedAt - vol.lastPriceAt;
            uint256 next = (uint256(limits.volWindowSeconds) * vol.varRatePerSecond + r * r) /
                (uint256(limits.volWindowSeconds) + dt);
            vol.varRatePerSecond = next > type(uint128).max ? type(uint128).max : uint128(next);
        }
        vol.lastPriceE18 = uint128(priceE18);
        vol.lastPriceAt = uint64(markedAt);
        changed = true;
    }

    /// @dev Sigma over the stress horizon in bps, the k-sigma move in bps, and the
    ///      drawdown the vault would show if that move went against a position levered
    ///      `leverageX100` at today's equity. Direction is not guessed: the move is taken
    ///      as adverse. Leverage already carries the asset's decimals (the adapter divides
    ///      notional by equity), so the loss is a plain fraction of equity:
    ///          loss_bps = leverage * move_bps.
    function _stress(
        address vault,
        address adapter,
        RiskLimits memory limits,
        VolState memory vol,
        uint256 leverageX100
    ) private view returns (uint256 sigmaBps, uint256 moveBps, uint256 stressedDrawdownBps) {
        // variance over the horizon = rate * seconds, still 1e36-scaled; its square root
        // is a 1e18-scaled sigma, and 1e14 of those make a basis point.
        sigmaBps = Math.sqrt(uint256(vol.varRatePerSecond) * limits.stressHorizonSeconds) / 1e14;
        moveBps = (sigmaBps * limits.stressSigmasX10) / 10;

        (uint256 equity,) = IVenueAdapter(adapter).markEquity(vault);
        uint256 supply = IMandateVaultView(vault).totalSupply();
        if (supply == 0) return (sigmaBps, moveBps, 0);

        if (leverageX100 > MAX_STRESS_LEVERAGE_X100) leverageX100 = MAX_STRESS_LEVERAGE_X100;
        uint256 lossBps = (leverageX100 * moveBps) / 100;
        uint256 navNow = Math.mulDiv(equity, ONE, supply);
        uint256 highWater = markOf[vault].highWaterNavPerShare;
        // The next mark would lift the high-water mark before any loss is measured
        // against it, so the stress is measured the same way.
        if (navNow > highWater) highWater = navNow;
        uint256 stressedNav = lossBps >= 10_000 ? 0 : navNow - Math.mulDiv(navNow, lossBps, 10_000);
        stressedDrawdownBps = _drawdownBps(stressedNav, highWater);
    }

    /// @dev Lowest market id in the allowlist. With a stress term the allowlist has
    ///      exactly one market, so this is the market whose volatility is measured.
    function _referenceMarket(uint32 allowed) private pure returns (uint256 id) {
        if (allowed == 0) return 0;
        while ((allowed >> id) & 1 == 0) ++id;
    }

    function _drawdownBps(uint256 navPerShare, uint256 highWater) private pure returns (uint256) {
        if (highWater == 0 || navPerShare >= highWater) return 0;
        return ((highWater - navPerShare) * 10_000) / highWater;
    }
}
