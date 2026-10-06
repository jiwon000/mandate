// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice A reproducible test venue. This is not a production price oracle and it
///         settles nothing: PnL is booked against a cash-flow basis, never paid in USDC.
/// @dev Several markets, each with its own price and timestamp. Market 0 is the one
///      the original single-market interface (`priceE18`, `setPrice`, `positionSizeE18`,
///      `netCostE18`, `trade`) reads and writes, so older callers keep working.
contract DeterministicMockVenue is Ownable {
    error UnauthorizedAdapter();
    error LimitPriceExceeded();
    error ZeroPrice();
    error UnknownMarket(uint256 marketId);
    error TooManyMarkets();
    error LengthMismatch();

    /// @notice Hard cap on markets so equity reads stay bounded in gas.
    uint256 public constant MAX_MARKETS = 8;

    struct Market {
        string symbol;
        uint256 priceE18;
        uint256 updatedAt;
    }

    Market[] private markets;
    mapping(address => bool) public isAdapter;
    mapping(address => mapping(uint256 => int256)) public positionOf;

    /// @notice Signed cumulative cash paid into a position, in 1e18 USD.
    /// @dev Cash-flow basis: unrealised PnL = positionValue - cost, which stays exact
    ///      across partial closes and side flips without tracking an entry price.
    mapping(address => mapping(uint256 => int256)) public costOf;

    event PriceSet(uint256 priceE18, uint256 timestamp);
    event MarketPriceSet(uint256 indexed marketId, uint256 priceE18, uint256 timestamp);
    event MarketAdded(uint256 indexed marketId, string symbol, uint256 priceE18);
    event AdapterSet(address indexed adapter, bool allowed);
    event Traded(address indexed vault, int256 sizeDeltaE18, int256 resultingSizeE18, uint256 priceE18);
    event MarketTraded(
        address indexed vault,
        uint256 indexed marketId,
        int256 sizeDeltaE18,
        int256 resultingSizeE18,
        uint256 priceE18
    );

    constructor(uint256 initialPriceE18) Ownable(msg.sender) {
        _addMarket("ETH", initialPriceE18);
    }

    // --- markets ---------------------------------------------------------------

    function addMarket(string calldata symbol, uint256 priceE18_) external onlyOwner returns (uint256 marketId) {
        return _addMarket(symbol, priceE18_);
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function marketOf(uint256 marketId) external view returns (string memory symbol, uint256 price, uint256 at) {
        Market storage m = _market(marketId);
        return (m.symbol, m.priceE18, m.updatedAt);
    }

    function priceOf(uint256 marketId) public view returns (uint256) {
        return _market(marketId).priceE18;
    }

    function updatedAtOf(uint256 marketId) public view returns (uint256) {
        return _market(marketId).updatedAt;
    }

    function setMarketPrice(uint256 marketId, uint256 newPriceE18) public onlyOwner {
        if (newPriceE18 == 0) revert ZeroPrice();
        Market storage m = _market(marketId);
        m.priceE18 = newPriceE18;
        m.updatedAt = block.timestamp;
        emit MarketPriceSet(marketId, newPriceE18, block.timestamp);
        if (marketId == 0) emit PriceSet(newPriceE18, block.timestamp);
    }

    /// @notice Mark every market in one transaction, market 0 first.
    function setPrices(uint256[] calldata pricesE18) external onlyOwner {
        if (pricesE18.length != markets.length) revert LengthMismatch();
        for (uint256 i; i < pricesE18.length; ++i) setMarketPrice(i, pricesE18[i]);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        isAdapter[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function tradeMarket(address vault, uint256 marketId, int256 sizeDeltaE18, uint256 limitPriceE18)
        public
        returns (uint256)
    {
        if (!isAdapter[msg.sender]) revert UnauthorizedAdapter();
        uint256 currentPrice = _market(marketId).priceE18;
        if (sizeDeltaE18 > 0 && currentPrice > limitPriceE18) revert LimitPriceExceeded();
        if (sizeDeltaE18 < 0 && currentPrice < limitPriceE18) revert LimitPriceExceeded();

        int256 resulting = positionOf[vault][marketId] + sizeDeltaE18;
        positionOf[vault][marketId] = resulting;
        costOf[vault][marketId] += (sizeDeltaE18 * int256(currentPrice)) / 1e18;
        emit MarketTraded(vault, marketId, sizeDeltaE18, resulting, currentPrice);
        if (marketId == 0) emit Traded(vault, sizeDeltaE18, resulting, currentPrice);
        return currentPrice;
    }

    /// @notice Unrealised PnL of `vault`'s position in one market at its mark, in 1e18 USD.
    function unrealizedPnlOf(address vault, uint256 marketId) public view returns (int256) {
        int256 markValue = (positionOf[vault][marketId] * int256(_market(marketId).priceE18)) / 1e18;
        return markValue - costOf[vault][marketId];
    }

    // --- single-market interface (market 0) -----------------------------------

    function priceE18() external view returns (uint256) {
        return markets[0].priceE18;
    }

    function updatedAt() external view returns (uint256) {
        return markets[0].updatedAt;
    }

    function setPrice(uint256 newPriceE18) external onlyOwner {
        setMarketPrice(0, newPriceE18);
    }

    function positionSizeE18(address vault) external view returns (int256) {
        return positionOf[vault][0];
    }

    function netCostE18(address vault) external view returns (int256) {
        return costOf[vault][0];
    }

    function trade(address vault, int256 sizeDeltaE18, uint256 limitPriceE18) external returns (uint256) {
        return tradeMarket(vault, 0, sizeDeltaE18, limitPriceE18);
    }

    function unrealizedPnlE18(address vault) external view returns (int256) {
        return unrealizedPnlOf(vault, 0);
    }

    function _addMarket(string memory symbol, uint256 price) private returns (uint256 marketId) {
        if (price == 0) revert ZeroPrice();
        if (markets.length >= MAX_MARKETS) revert TooManyMarkets();
        marketId = markets.length;
        markets.push(Market(symbol, price, block.timestamp));
        emit MarketAdded(marketId, symbol, price);
    }

    function _market(uint256 marketId) private view returns (Market storage) {
        if (marketId >= markets.length) revert UnknownMarket(marketId);
        return markets[marketId];
    }
}
