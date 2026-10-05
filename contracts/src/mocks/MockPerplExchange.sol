// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPerplExchange} from "../perpl/IPerplExchange.sol";

/// @notice A small stand-in for Perpl's Exchange, for testing PerplAdapter without a
///         network. Test-only: it is not part of any deployment.
/// @dev Models what the adapter relies on and what the fork showed: accounts keyed
///      by msg.sender with a 100-unit opening minimum, isolated positions holding
///      notional / leverage as margin, a taker fee, immediate-or-cancel and
///      fill-or-kill semantics (an unfilled fill-or-kill reverts), opens that net
///      against an opposite position and flip through flat, reduce-only closes, and
///      a 60-second mark age limit. Each perpetual can be paused, given a fill price
///      off the mark, or limited to so many lots per order, to reach the paths a
///      fork cannot. Funding, liquidation and the order book are not modelled.
contract MockPerplExchange {
    using SafeERC20 for IERC20;

    error ContractNotOperational(uint256 perpId);
    error MarkPriceAgeExceedsMax(uint256 perpId);
    error UnmatchedLotRemainsInFillOrKill(uint256 perpId, uint256 accountId, uint256 lotLNS);
    error InsufficientBalance(uint256 needCNS, uint256 balanceCNS);
    error AccountExists();
    error NoAccount();
    error BelowMinimum();
    error WithdrawLimited();
    error NotReduceOnly();

    uint256 public constant MIN_OPEN_CNS = 100e6;
    uint256 public constant TAKER_FEE_PER_100K = 35; // 0.035%
    uint256 public constant MAX_AGE_SEC = 60;

    struct Perp {
        uint256 priceDecimals;
        uint256 lotDecimals;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 fillPNS; // 0 = fill at the mark
        uint256 maxLotsPerOrder; // 0 = unlimited
        bool paused;
    }

    struct Position {
        uint8 positionType;
        uint256 lotLNS;
        uint256 pricePNS;
        uint256 depositCNS;
    }

    IERC20 public immutable collateral;
    address public immutable owner;
    bool public withdrawBlocked;
    uint256 public nextAccountId = 1;

    mapping(uint256 => Perp) public perps;
    mapping(address => uint256) public accountOf;
    mapping(uint256 => uint256) public balanceOf;
    mapping(uint256 => mapping(uint256 => Position)) internal positions;

    constructor(IERC20 collateral_) {
        collateral = collateral_;
        owner = msg.sender;
    }

    // ------------------------------------------------------------ test knobs

    function listPerp(uint256 perpId, uint256 priceDecimals, uint256 lotDecimals, uint256 markPNS) external {
        perps[perpId] = Perp(priceDecimals, lotDecimals, markPNS, block.timestamp, 0, 0, false);
    }

    function setMark(uint256 perpId, uint256 markPNS, uint256 markTimestamp) external {
        perps[perpId].markPNS = markPNS;
        perps[perpId].markTimestamp = markTimestamp;
    }

    function setFill(uint256 perpId, uint256 fillPNS, uint256 maxLotsPerOrder) external {
        perps[perpId].fillPNS = fillPNS;
        perps[perpId].maxLotsPerOrder = maxLotsPerOrder;
    }

    function setPaused(uint256 perpId, bool paused) external {
        perps[perpId].paused = paused;
    }

    function setWithdrawBlocked(bool blocked) external {
        withdrawBlocked = blocked;
    }

    // -------------------------------------------------------------- accounts

    function createAccount(uint256 amountCNS) external returns (uint256 accountId) {
        if (accountOf[msg.sender] != 0) revert AccountExists();
        if (amountCNS < MIN_OPEN_CNS) revert BelowMinimum();
        collateral.safeTransferFrom(msg.sender, address(this), amountCNS);
        accountId = nextAccountId++;
        accountOf[msg.sender] = accountId;
        balanceOf[accountId] = amountCNS;
    }

    function depositCollateral(uint256 amountCNS) external {
        uint256 id = _account(msg.sender);
        collateral.safeTransferFrom(msg.sender, address(this), amountCNS);
        balanceOf[id] += amountCNS;
    }

    function withdrawCollateral(uint256 amountCNS) external {
        if (withdrawBlocked) revert WithdrawLimited();
        uint256 id = _account(msg.sender);
        if (balanceOf[id] < amountCNS) revert InsufficientBalance(amountCNS, balanceOf[id]);
        balanceOf[id] -= amountCNS;
        collateral.safeTransfer(msg.sender, amountCNS);
    }

    // ---------------------------------------------------------------- orders

    function execOrder(IPerplExchange.OrderDesc calldata d) external returns (IPerplExchange.OrderSignature memory sig) {
        uint256 id = _account(msg.sender);
        sig.perpId = d.perpId;
        (uint256 fillable, uint256 price) = _fillable(d, id);
        if (fillable == 0) return sig;
        Perp memory p = perps[d.perpId];
        Position storage pos = positions[d.perpId][id];
        uint8 side = (d.orderType == 0 || d.orderType == 3) ? 0 : 1;
        uint256 remaining = fillable;
        if (pos.lotLNS != 0 && pos.positionType != side) {
            uint256 closing = Math.min(remaining, pos.lotLNS);
            _reduce(p, pos, id, closing, price);
            remaining -= closing;
        }
        if (remaining != 0 && d.orderType < 2) _open(p, pos, id, side, remaining, price, d.leverageHdths);
        // The fee comes out of the account after the close part has paid it back in,
        // so a close against an account with no free balance still goes through.
        _charge(id, Math.mulDiv(_notionalCNS(p, fillable, price), TAKER_FEE_PER_100K, 100_000));
    }

    /// @dev Lots this order fills and the price it fills at; reverts where Perpl would.
    function _fillable(IPerplExchange.OrderDesc calldata d, uint256 id)
        private view returns (uint256 fillable, uint256 price)
    {
        Perp memory p = perps[d.perpId];
        if (p.paused) revert ContractNotOperational(d.perpId);
        if (block.timestamp > p.markTimestamp + MAX_AGE_SEC) revert MarkPriceAgeExceedsMax(d.perpId);
        bool buy = d.orderType == 0 || d.orderType == 3;
        price = p.fillPNS == 0 ? p.markPNS : p.fillPNS;
        fillable = d.lotLNS;
        if (d.orderType >= 2) {
            // Reduce-only: a close never exceeds the position on its side.
            Position memory pos = positions[d.perpId][id];
            if (pos.lotLNS == 0 || pos.positionType != (d.orderType == 2 ? 0 : 1)) revert NotReduceOnly();
            fillable = Math.min(fillable, pos.lotLNS);
        }
        if (buy ? price > d.pricePNS : price < d.pricePNS) fillable = 0;
        if (p.maxLotsPerOrder != 0 && fillable > p.maxLotsPerOrder) fillable = p.maxLotsPerOrder;
        if (d.fillOrKill && fillable < d.lotLNS) {
            revert UnmatchedLotRemainsInFillOrKill(d.perpId, id, d.lotLNS - fillable);
        }
    }

    function _open(
        Perp memory p, Position storage pos, uint256 id, uint8 side, uint256 lots, uint256 price, uint256 leverageHdths
    ) private {
        uint256 margin = Math.mulDiv(_notionalCNS(p, lots, price), 100, leverageHdths);
        _charge(id, margin);
        if (pos.lotLNS == 0) {
            pos.positionType = side;
            pos.pricePNS = price;
        } else {
            pos.pricePNS = (pos.pricePNS * pos.lotLNS + price * lots) / (pos.lotLNS + lots);
        }
        pos.lotLNS += lots;
        pos.depositCNS += margin;
    }

    function _reduce(Perp memory p, Position storage pos, uint256 id, uint256 lots, uint256 price) private {
        uint256 released = Math.mulDiv(pos.depositCNS, lots, pos.lotLNS);
        int256 move = pos.positionType == 0
            ? int256(price) - int256(pos.pricePNS)
            : int256(pos.pricePNS) - int256(price);
        int256 pnl = (move * int256(lots) * 1e6) / int256(10 ** (p.priceDecimals + p.lotDecimals));
        int256 back = int256(released) + pnl;
        pos.depositCNS -= released;
        pos.lotLNS -= lots;
        if (back > 0) balanceOf[id] += uint256(back);
    }

    function _charge(uint256 id, uint256 amount) private {
        if (balanceOf[id] < amount) revert InsufficientBalance(amount, balanceOf[id]);
        balanceOf[id] -= amount;
    }

    /// @dev lots * price in 6dp collateral units.
    function _notionalCNS(Perp memory p, uint256 lots, uint256 price) private pure returns (uint256) {
        return Math.mulDiv(lots * price, 1e6, 10 ** (p.priceDecimals + p.lotDecimals));
    }

    function _account(address who) private view returns (uint256 id) {
        id = accountOf[who];
        if (id == 0) revert NoAccount();
    }

    // ----------------------------------------------------------------- views

    function getAccountByAddr(address accountAddress) external view returns (IPerplExchange.AccountInfo memory a) {
        a.accountId = accountOf[accountAddress];
        a.balanceCNS = balanceOf[a.accountId];
        a.accountAddr = accountAddress;
    }

    function getPositionV2(uint256 perpId, uint256 accountId)
        external view returns (IPerplExchange.PositionInfo memory info, uint256 markPricePNS, bool markPriceValid)
    {
        Position memory pos = positions[perpId][accountId];
        Perp memory p = perps[perpId];
        info.accountId = accountId;
        info.positionType = pos.positionType;
        info.lotLNS = pos.lotLNS;
        info.pricePNS = pos.pricePNS;
        info.depositCNS = pos.depositCNS;
        markPricePNS = p.markPNS;
        markPriceValid = block.timestamp <= p.markTimestamp + MAX_AGE_SEC;
    }

    function getPerpetualInfoV2(uint256 perpId) external view returns (IPerplExchange.PerpetualInfo memory info) {
        Perp memory p = perps[perpId];
        info.priceDecimals = p.priceDecimals;
        info.lotDecimals = p.lotDecimals;
        info.markPNS = p.markPNS;
        info.markTimestamp = p.markTimestamp;
        info.refPriceMaxAgeSec = MAX_AGE_SEC;
        info.status = p.paused ? 1 : 0;
    }

    function getMinAccountOpenCNS() external pure returns (uint256) {
        return MIN_OPEN_CNS;
    }
}
