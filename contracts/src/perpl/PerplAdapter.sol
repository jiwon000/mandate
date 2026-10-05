// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVenueAdapter, IMandateVaultView, TradePreview} from "../interfaces/IMandate.sol";
import {IPerplExchange} from "./IPerplExchange.sol";
import {PerplSubaccount} from "./PerplSubaccount.sol";

/// @notice Venue adapter for Perpl, the order-book perp exchange on Monad.
/// @dev Orders use MockVenueAdapter's encoding, `abi.encode(int256 sizeDeltaE18,
///      uint256 limitPriceE18)` for market 0 or `abi.encode(uint256 marketId, int256
///      sizeDeltaE18, uint256 limitPriceE18)`, so the agent side does not change.
///      Market ids map to Perpl perpetual ids at construction.
///
///      Custody. Perpl keys accounts by msg.sender and holds margin per position, so
///      each vault gets a PerplSubaccount the first time it trades. execute() pulls
///      the margin an order needs from the vault (the vault approves its own cash to
///      its adapter for the length of the call) and, after the fill, sends whatever
///      the Perpl account holds free back to the vault. Between trades the vault's
///      money is its idle cash plus the margin locked in open positions.
///
///      Price. Every price and timestamp comes from Perpl's own mark
///      (getPerpetualInfoV2: markPNS, markTimestamp). Perpl writes it on chain when
///      it moves 0.05% or nears expiry, so markedAt is Perpl's clock, never
///      block.timestamp, and the guard's freshness check reads a real age.
///
///      Not modelled: funding payments (premiumPnlCNS) are left out of equity, and
///      fees paid at the fill reduce equity only once they leave the account. Both are
///      small next to price PnL over a mandate's horizon but are not zero.
contract PerplAdapter is IVenueAdapter {
    using SafeERC20 for IERC20;

    error OnlyVault();
    error ZeroOrder();
    error ZeroLimit();
    error BadOrder();
    error BadFraction();
    error UnknownMarket(uint256 marketId);
    error LotNotRepresentable(uint256 lotUnitE18);
    error NoMarkets();

    uint256 private constant ASSET_TO_E18 = 1e12;
    uint8 private constant OPEN_LONG = 0;
    uint8 private constant OPEN_SHORT = 1;
    uint8 private constant CLOSE_LONG = 2;
    uint8 private constant CLOSE_SHORT = 3;

    /// @notice Worst fill reduce() accepts, relative to Perpl's mark.
    uint16 public constant MAX_UNWIND_SLIPPAGE_BPS = 100;
    /// @notice Margin pulled on top of notional / leverage, for the taker fee and a
    ///         fill above the mark.
    uint16 public constant MARGIN_BUFFER_BPS = 200;
    /// @notice Collateral pulled with every order, for the taker fee.
    uint16 public constant FEE_FLOAT_BPS = 10;

    IPerplExchange public immutable exchange;
    IERC20 public immutable collateral;
    /// @notice Leverage each Perpl position is opened at, in hundredths (500 = 5x).
    /// @dev This is the venue's margin setting, not the mandate's leverage term. The
    ///      mandate measures leverage against the vault's whole equity; this decides
    ///      how much of that equity sits at Perpl as margin.
    uint256 public immutable venueLeverageHdths;

    uint256[] private perpIds;
    mapping(address => PerplSubaccount) public subaccountOf;
    mapping(address => uint256) public accountIdOf;
    mapping(address => uint256) private descIds;

    event SubaccountOpened(address indexed vault, address subaccount, uint256 accountId);

    constructor(
        IPerplExchange exchange_,
        IERC20 collateral_,
        uint256 venueLeverageHdths_,
        uint256[] memory perpIds_
    ) {
        if (perpIds_.length == 0) revert NoMarkets();
        exchange = exchange_;
        collateral = collateral_;
        venueLeverageHdths = venueLeverageHdths_;
        perpIds = perpIds_;
    }

    function marketCount() external view returns (uint256) {
        return perpIds.length;
    }

    function perpIdOf(uint256 marketId) public view returns (uint256) {
        if (marketId >= perpIds.length) revert UnknownMarket(marketId);
        return perpIds[marketId];
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

    // ------------------------------------------------------------------ views

    struct Market {
        uint256 perpId;
        uint256 markE18;
        uint256 markedAt;
        uint256 priceUnit; // 10^(18 - priceDecimals)
        uint256 lotUnit; // 10^(18 - lotDecimals)
    }

    function _market(uint256 marketId) private view returns (Market memory m) {
        m.perpId = perpIdOf(marketId);
        IPerplExchange.PerpetualInfo memory info = exchange.getPerpetualInfoV2(m.perpId);
        m.priceUnit = 10 ** (18 - info.priceDecimals);
        m.lotUnit = 10 ** (18 - info.lotDecimals);
        m.markE18 = info.markPNS * m.priceUnit;
        m.markedAt = info.markTimestamp;
    }

    /// @dev Signed size in 1e18 units, entry price 1e18-scaled, margin held (6dp).
    function _position(address vault, Market memory m)
        private view returns (int256 sizeE18, uint256 entryE18, uint256 depositCNS)
    {
        uint256 accountId = accountIdOf[vault];
        if (accountId == 0) return (0, 0, 0);
        (IPerplExchange.PositionInfo memory p,,) = exchange.getPositionV2(m.perpId, accountId);
        if (p.lotLNS == 0) return (0, 0, 0);
        int256 size = int256(p.lotLNS * m.lotUnit);
        sizeE18 = p.positionType == 0 ? size : -size;
        entryE18 = p.pricePNS * m.priceUnit;
        depositCNS = p.depositCNS;
    }

    function preview(address vault, bytes calldata order) public view returns (TradePreview memory p) {
        (uint256 marketId, int256 sizeDeltaE18, uint256 limitPriceE18) = decodeOrder(order);
        if (sizeDeltaE18 == 0) revert ZeroOrder();
        Market memory traded = _market(marketId);
        if (_abs(sizeDeltaE18) % traded.lotUnit != 0) revert LotNotRepresentable(traded.lotUnit);

        (int256 size,,) = _position(vault, traded);
        int256 resultingSize = size + sizeDeltaE18;
        p.orderNotional = Math.mulDiv(_abs(sizeDeltaE18), traded.markE18, 1e18);

        uint256 count = perpIds.length;
        for (uint256 i; i < count; ++i) {
            uint256 notional;
            if (i == marketId) {
                notional = Math.mulDiv(_abs(resultingSize), traded.markE18, 1e18);
            } else {
                Market memory other = _market(i);
                (int256 otherSize,,) = _position(vault, other);
                notional = Math.mulDiv(_abs(otherSize), other.markE18, 1e18);
            }
            if (notional > p.expectedPositionNotional) p.expectedPositionNotional = notional;
            p.expectedTotalNotional += notional;
        }

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
        p.markPriceE18 = traded.markE18;
    }

    function positionState(address vault)
        external view returns (uint256 positionNotional, uint256 totalNotional)
    {
        uint256 count = perpIds.length;
        for (uint256 i; i < count; ++i) {
            Market memory m = _market(i);
            (int256 size,,) = _position(vault, m);
            uint256 notional = Math.mulDiv(_abs(size), m.markE18, 1e18);
            if (notional > positionNotional) positionNotional = notional;
            totalNotional += notional;
        }
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Idle cash in the vault, free collateral in the Perpl account, and for each
    ///      open position its margin plus price PnL at Perpl's mark. `markedAt` is the
    ///      oldest mark among the markets held; a flat vault is marked by market 0.
    function markEquity(address vault) public view returns (uint256 equity, uint256 markedAt) {
        int256 equityE18 = int256(IMandateVaultView(vault).totalAssets() * ASSET_TO_E18);
        if (accountIdOf[vault] != 0) {
            IPerplExchange.AccountInfo memory a = exchange.getAccountByAddr(address(subaccountOf[vault]));
            equityE18 += int256((a.balanceCNS + a.lockedBalanceCNS) * ASSET_TO_E18);
            uint256 count = perpIds.length;
            for (uint256 i; i < count; ++i) {
                Market memory m = _market(i);
                (int256 size, uint256 entryE18, uint256 depositCNS) = _position(vault, m);
                if (size == 0) continue;
                equityE18 += int256(depositCNS * ASSET_TO_E18);
                equityE18 += ((int256(m.markE18) - int256(entryE18)) * size) / 1e18;
                if (markedAt == 0 || m.markedAt < markedAt) markedAt = m.markedAt;
            }
        }
        if (markedAt == 0) markedAt = _market(0).markedAt;
        equity = equityE18 <= 0 ? 0 : uint256(equityE18) / ASSET_TO_E18;
    }

    /// @inheritdoc IVenueAdapter
    function markPrice(address) external view returns (uint256 priceE18, uint256 markedAt) {
        Market memory m = _market(0);
        return (m.markE18, m.markedAt);
    }

    /// @inheritdoc IVenueAdapter
    function marketPrice(uint256 marketId) external view returns (uint256 priceE18, uint256 markedAt) {
        Market memory m = _market(marketId);
        return (m.markE18, m.markedAt);
    }

    // ---------------------------------------------------------------- trading

    function execute(address vault, bytes calldata order)
        external returns (int256 realizedPnl, uint256 amountOut)
    {
        if (msg.sender != vault) revert OnlyVault();
        (uint256 marketId, int256 sizeDeltaE18, uint256 limitPriceE18) = decodeOrder(order);
        if (sizeDeltaE18 == 0) revert ZeroOrder();
        if (limitPriceE18 == 0) revert ZeroLimit();
        Market memory m = _market(marketId);
        if (_abs(sizeDeltaE18) % m.lotUnit != 0) revert LotNotRepresentable(m.lotUnit);

        (int256 size,,) = _position(vault, m);
        PerplSubaccount sub = _fund(vault, _marginFor(size, sizeDeltaE18, limitPriceE18));
        _place(vault, sub, m, sizeDeltaE18, limitPriceE18);
        _release(vault);
        // Perpl reports the fill in events, not return values. The vault compares the
        // position this leaves against preview() and reverts on any partial fill.
        return (0, limitPriceE18);
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Takes the same fraction off every Perpl position the vault holds, with
    ///      Perpl's reduce-only close orders, so a step can never flip or grow one.
    function reduce(address vault, uint16 fractionBps)
        external returns (uint256 closedNotional, int256 realizedPnl)
    {
        if (msg.sender != vault) revert OnlyVault();
        if (fractionBps == 0 || fractionBps > 10_000) revert BadFraction();
        uint256 count = perpIds.length;
        for (uint256 i; i < count; ++i) {
            Market memory m = _market(i);
            (int256 size, uint256 entryE18,) = _position(vault, m);
            if (size == 0) continue;
            uint256 lots = _abs(size) / m.lotUnit;
            uint256 slice = (lots * fractionBps) / 10_000;
            if (slice == 0) slice = 1;
            bool long = size > 0;
            uint256 limit = long
                ? Math.mulDiv(m.markE18, 10_000 - MAX_UNWIND_SLIPPAGE_BPS, 10_000) / m.priceUnit
                : Math.ceilDiv(Math.mulDiv(m.markE18, 10_000 + MAX_UNWIND_SLIPPAGE_BPS, 10_000), m.priceUnit);
            subaccountOf[vault].order(_desc(vault, m.perpId, long ? CLOSE_LONG : CLOSE_SHORT, limit, slice));

            (int256 after_,,) = _position(vault, m);
            uint256 closedE18 = _abs(size) - _abs(after_);
            closedNotional += Math.mulDiv(closedE18, m.markE18, 1e18);
            int256 pnlE18 = ((int256(m.markE18) - int256(entryE18)) * size) / 1e18;
            realizedPnl += (pnlE18 * int256(closedE18)) / int256(_abs(size));
        }
        _release(vault);
    }

    /// @notice Send the free collateral in a vault's Perpl account back to the vault.
    /// @dev Permissionless: the money can only go to the vault. A withdrawal Perpl
    ///      refuses (its withdrawal rate limit, say) leaves the money where it is,
    ///      still counted in markEquity.
    function sweep(address vault) external {
        _release(vault);
    }

    /// @dev Collateral an order needs at Perpl: margin for the exposure it adds at the
    ///      venue leverage plus a buffer, and a float for the taker fee.
    function _marginFor(int256 size, int256 sizeDeltaE18, uint256 limitPriceE18)
        private view returns (uint256 needCNS)
    {
        uint256 addedE18 = _addedExposure(size, size + sizeDeltaE18);
        needCNS = Math.mulDiv(addedE18, limitPriceE18, 1e18) / ASSET_TO_E18;
        needCNS = Math.mulDiv(needCNS, 100 * (10_000 + uint256(MARGIN_BUFFER_BPS)), venueLeverageHdths * 10_000);
        uint256 orderCNS = Math.mulDiv(_abs(sizeDeltaE18), limitPriceE18, 1e18) / ASSET_TO_E18;
        needCNS += (orderCNS * FEE_FLOAT_BPS) / 10_000 + 1;
    }

    function _place(address vault, PerplSubaccount sub, Market memory m, int256 sizeDeltaE18, uint256 limitPriceE18)
        private
    {
        bool buy = sizeDeltaE18 > 0;
        uint256 pricePNS = buy ? limitPriceE18 / m.priceUnit : Math.ceilDiv(limitPriceE18, m.priceUnit);
        sub.order(_desc(vault, m.perpId, buy ? OPEN_LONG : OPEN_SHORT, pricePNS, _abs(sizeDeltaE18) / m.lotUnit));
    }

    function _desc(address vault, uint256 perpId, uint8 orderType, uint256 pricePNS, uint256 lotLNS)
        private returns (IPerplExchange.OrderDesc memory d)
    {
        d.orderDescId = ++descIds[vault];
        d.perpId = perpId;
        d.orderType = orderType;
        d.pricePNS = pricePNS;
        d.lotLNS = lotLNS;
        d.fillOrKill = true;
        d.immediateOrCancel = true;
        d.leverageHdths = venueLeverageHdths;
        // The price bound is the agent's limit (and the guard's deviation term on it),
        // not Perpl's loss-at-entry check.
        d.maxNegPnlCollatBPS = 10_000;
    }

    function _fund(address vault, uint256 needCNS) private returns (PerplSubaccount sub) {
        sub = subaccountOf[vault];
        bool open = address(sub) == address(0);
        uint256 free;
        if (open) {
            sub = new PerplSubaccount{salt: bytes32(uint256(uint160(vault)))}(vault, exchange, collateral);
            subaccountOf[vault] = sub;
            uint256 minOpen = exchange.getMinAccountOpenCNS();
            if (needCNS < minOpen) needCNS = minOpen;
        } else {
            free = exchange.getAccountByAddr(address(sub)).balanceCNS;
        }
        if (needCNS > free) {
            uint256 pull = needCNS - free;
            collateral.safeTransferFrom(vault, address(sub), pull);
            sub.fund(pull, open);
        }
        if (open) {
            uint256 accountId = exchange.getAccountByAddr(address(sub)).accountId;
            accountIdOf[vault] = accountId;
            emit SubaccountOpened(vault, address(sub), accountId);
        }
    }

    function _release(address vault) private {
        PerplSubaccount sub = subaccountOf[vault];
        if (address(sub) == address(0)) return;
        uint256 free = exchange.getAccountByAddr(address(sub)).balanceCNS;
        if (free == 0) return;
        try sub.release(free) {} catch {}
    }

    /// @dev Size an order adds to the position's absolute exposure, 1e18 units. A
    ///      flip counts the whole new side.
    function _addedExposure(int256 before, int256 after_) private pure returns (uint256) {
        if (after_ == 0) return 0;
        if (before == 0 || (before > 0) != (after_ > 0)) return _abs(after_);
        return _abs(after_) > _abs(before) ? _abs(after_) - _abs(before) : 0;
    }

    function _abs(int256 value) private pure returns (uint256) {
        return value >= 0 ? uint256(value) : uint256(-value);
    }
}
