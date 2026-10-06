// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of Perpl's Exchange that PerplAdapter uses.
/// @dev Taken from the Exchange ABI in PerplFoundation/dex-sdk
///      (crates/sdk/abi/dex/Exchange.json, revision rc_v1.1.7-203-g0e5902dd). Struct
///      layouts are copied field for field; only the functions called here are listed.
///      Prices are in "PNS" units (priceDecimals per perpetual), sizes in "LNS"
///      (lotDecimals per perpetual), collateral in "CNS" (the collateral token's 6dp).
interface IPerplExchange {
    struct OrderDesc {
        uint256 orderDescId;
        uint256 perpId;
        /// @dev 0 OpenLong, 1 OpenShort, 2 CloseLong, 3 CloseShort, 4 Cancel,
        ///      5 IncreasePositionCollateral, 6 Change (dex-sdk types/request.rs).
        uint8 orderType;
        uint256 orderId;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 expiryBlock;
        bool postOnly;
        bool fillOrKill;
        bool immediateOrCancel;
        uint256 maxMatches;
        uint256 leverageHdths;
        uint256 lastExecutionBlock;
        uint256 amountCNS;
        uint256 maxNegPnlCollatBPS;
    }

    struct OrderSignature {
        uint256 perpId;
        uint256 orderId;
    }

    struct PositionBitMap {
        uint256 bank1;
        uint256 bank2;
        uint256 bank3;
        uint256 bank4;
    }

    struct AccountInfo {
        uint256 accountId;
        uint256 balanceCNS;
        uint256 lockedBalanceCNS;
        uint8 frozen;
        address accountAddr;
        PositionBitMap positions;
    }

    struct PositionInfo {
        uint256 accountId;
        uint256 nextNodeId;
        uint256 prevNodeId;
        /// @dev 0 long, 1 short.
        uint8 positionType;
        uint256 depositCNS;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 entryBlock;
        int256 pnlCNS;
        int256 deltaPnlCNS;
        int256 premiumPnlCNS;
        uint256 priceResiduePNSQ16;
    }

    struct PerpetualInfo {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
        uint256 fundingSumScalingExp;
    }

    function createAccount(uint256 amountCNS) external returns (uint256 accountId);
    function depositCollateral(uint256 amountCNS) external;
    function withdrawCollateral(uint256 amountCNS) external;
    function execOrder(OrderDesc calldata orderDesc) external returns (OrderSignature memory);

    function getAccountByAddr(address accountAddress) external view returns (AccountInfo memory);
    function getPositionV2(uint256 perpId, uint256 accountId)
        external view returns (PositionInfo memory positionInfo, uint256 markPricePNS, bool markPriceValid);
    function getPerpetualInfoV2(uint256 perpId) external view returns (PerpetualInfo memory);
    function getMinAccountOpenCNS() external view returns (uint256);
}
