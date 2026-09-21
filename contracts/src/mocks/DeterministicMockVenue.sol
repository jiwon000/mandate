// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice A reproducible test venue. This is not a production price oracle.
contract DeterministicMockVenue is Ownable {
    error UnauthorizedAdapter();
    error LimitPriceExceeded();
    error ZeroPrice();

    uint256 public priceE18;
    uint256 public updatedAt;
    mapping(address => bool) public isAdapter;
    mapping(address => int256) public positionSizeE18;

    /// @notice Signed cumulative cash paid into the position, in 1e18 USD.
    /// @dev Cash-flow basis: unrealised PnL = positionValue - netCostE18, which stays
    ///      exact across partial closes and side flips without tracking an entry price.
    mapping(address => int256) public netCostE18;

    event PriceSet(uint256 priceE18, uint256 timestamp);
    event AdapterSet(address indexed adapter, bool allowed);
    event Traded(address indexed vault, int256 sizeDeltaE18, int256 resultingSizeE18, uint256 priceE18);

    constructor(uint256 initialPriceE18) Ownable(msg.sender) {
        if (initialPriceE18 == 0) revert ZeroPrice();
        priceE18 = initialPriceE18;
        updatedAt = block.timestamp;
    }

    function setPrice(uint256 newPriceE18) external onlyOwner {
        if (newPriceE18 == 0) revert ZeroPrice();
        priceE18 = newPriceE18;
        updatedAt = block.timestamp;
        emit PriceSet(newPriceE18, block.timestamp);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        isAdapter[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function trade(address vault, int256 sizeDeltaE18, uint256 limitPriceE18) external returns (uint256) {
        if (!isAdapter[msg.sender]) revert UnauthorizedAdapter();
        uint256 currentPrice = priceE18;
        if (sizeDeltaE18 > 0 && currentPrice > limitPriceE18) revert LimitPriceExceeded();
        if (sizeDeltaE18 < 0 && currentPrice < limitPriceE18) revert LimitPriceExceeded();

        positionSizeE18[vault] += sizeDeltaE18;
        netCostE18[vault] += (sizeDeltaE18 * int256(currentPrice)) / 1e18;
        emit Traded(vault, sizeDeltaE18, positionSizeE18[vault], currentPrice);
        return currentPrice;
    }

    /// @notice Unrealised PnL of `vault`'s open position at the current mark, in 1e18 USD.
    function unrealizedPnlE18(address vault) external view returns (int256) {
        int256 markValue = (positionSizeE18[vault] * int256(priceE18)) / 1e18;
        return markValue - netCostE18[vault];
    }
}
