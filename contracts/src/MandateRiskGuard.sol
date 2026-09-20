// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRiskGuard, RiskLimits, TradePreview} from "./interfaces/IMandate.sol";

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

    struct BlockUsage {
        uint64 blockNumber;
        uint192 notional;
    }

    mapping(address => RiskLimits) public limitsOf;
    mapping(address => bool) public configured;
    mapping(address => mapping(address => bool)) public adapterAllowed;
    mapping(address => BlockUsage) public blockUsageOf;
    mapping(address => uint256) public lastTradeBlock;

    event LimitsConfigured(address indexed vault);
    event AdapterAllowed(address indexed vault, address indexed adapter, bool allowed);
    event RiskConsumed(address indexed vault, bytes32 indexed orderHash, uint256 notional);

    constructor() Ownable(msg.sender) {}

    function configure(address vault, RiskLimits calldata limits) external onlyOwner {
        limitsOf[vault] = limits;
        configured[vault] = true;
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
}
