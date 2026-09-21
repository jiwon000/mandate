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

    /// @dev NAV per share is scaled so a freshly funded vault starts at exactly 1e18.
    uint256 private constant ONE = 1e18;

    struct BlockUsage {
        uint64 blockNumber;
        uint192 notional;
    }

    struct MarkState {
        uint128 highWaterNavPerShare;
        uint64 lastMarkedAt;
        bool breached;
    }

    mapping(address => RiskLimits) public limitsOf;
    mapping(address => bool) public configured;
    mapping(address => mapping(address => bool)) public adapterAllowed;
    mapping(address => BlockUsage) public blockUsageOf;
    mapping(address => uint256) public lastTradeBlock;
    mapping(address => MarkState) public markOf;

    event LimitsConfigured(address indexed vault);
    event AdapterAllowed(address indexed vault, address indexed adapter, bool allowed);
    event RiskConsumed(address indexed vault, bytes32 indexed orderHash, uint256 notional);
    event Marked(address indexed vault, uint256 navPerShare, uint256 highWaterNavPerShare, uint256 drawdownBps);
    event DrawdownBreach(
        address indexed vault,
        address indexed caller,
        uint256 navPerShare,
        uint256 drawdownBps,
        uint256 bounty
    );

    constructor() Ownable(msg.sender) {}

    function configure(address vault, RiskLimits calldata limits) external onlyOwner {
        limitsOf[vault] = limits;
        configured[vault] = true;
        // Seed the high-water mark at par. Shares are minted 1:1 against the first
        // deposit, so NAV per share is 1e18 before any trade; without this seed the
        // first poke() after a loss would anchor the mark to the already-lost value.
        if (markOf[vault].highWaterNavPerShare == 0) {
            markOf[vault].highWaterNavPerShare = uint128(ONE);
        }
        emit LimitsConfigured(vault);
    }

    function setAdapter(address vault, address adapter, bool allowed) external onlyOwner {
        adapterAllowed[vault][adapter] = allowed;
        emit AdapterAllowed(vault, adapter, allowed);
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
        if (trade.orderNotional > limits.maxOrderNotional) revert OrderNotionalExceeded();
        if (trade.expectedPositionNotional > limits.maxPositionNotional) revert PositionNotionalExceeded();
        if (trade.expectedTotalNotional > limits.maxTotalNotional) revert TotalNotionalExceeded();
        if (trade.expectedLeverageX100 > limits.maxLeverageX100) revert LeverageExceeded();
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

    /// @notice Re-mark a vault and freeze it if the drawdown limit is breached.
    /// @dev Permissionless and bountied. This is the half of the guarantee that does not
    ///      depend on the agent choosing to trade: an agent that opens a levered position
    ///      and then goes quiet is never checked by checkAndConsumeBefore alone.
    ///      Enforcement precision is bounded by how often this can run, which is bounded
    ///      by the block time.
    function poke(address vault, address adapter) external returns (bool frozen) {
        if (!configured[vault]) revert LimitsNotConfigured();
        if (!adapterAllowed[vault][adapter]) revert AdapterNotAllowed();
        return _markAndCheck(vault, adapter, msg.sender);
    }

    /// @inheritdoc IRiskGuard
    function checkAfter(address vault, address adapter) external {
        if (msg.sender != vault) revert OnlyVault();
        if (!configured[vault]) revert LimitsNotConfigured();
        _markAndCheck(vault, adapter, address(0));
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

    function _markAndCheck(address vault, address adapter, address beneficiary)
        internal
        returns (bool frozen)
    {
        RiskLimits memory limits = limitsOf[vault];
        (uint256 equity, uint256 markedAt) = IVenueAdapter(adapter).markEquity(vault);

        if (limits.maxMarkAgeSeconds != 0 && block.timestamp > markedAt + limits.maxMarkAgeSeconds) {
            revert MarkTooOld(markedAt, limits.maxMarkAgeSeconds);
        }

        uint256 supply = IMandateVaultView(vault).totalSupply();
        if (supply == 0) return false;

        uint256 navPerShare = Math.mulDiv(equity, ONE, supply);
        MarkState storage mark = markOf[vault];
        if (navPerShare > mark.highWaterNavPerShare) {
            mark.highWaterNavPerShare = uint128(navPerShare);
        }
        mark.lastMarkedAt = uint64(block.timestamp);

        uint256 drawdownBps = _drawdownBps(navPerShare, mark.highWaterNavPerShare);
        emit Marked(vault, navPerShare, mark.highWaterNavPerShare, drawdownBps);

        if (limits.maxDrawdownBps == 0 || drawdownBps <= limits.maxDrawdownBps) {
            return false;
        }

        mark.breached = true;
        uint256 bounty = IMandateVaultFreeze(vault).freeze(beneficiary);
        emit DrawdownBreach(vault, beneficiary, navPerShare, drawdownBps, bounty);
        return true;
    }

    function _drawdownBps(uint256 navPerShare, uint256 highWater) private pure returns (uint256) {
        if (highWater == 0 || navPerShare >= highWater) return 0;
        return ((highWater - navPerShare) * 10_000) / highWater;
    }
}
