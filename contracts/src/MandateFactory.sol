// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MandateVault} from "./MandateVault.sol";
import {MandateRiskGuard} from "./MandateRiskGuard.sol";
import {MandateRegistry} from "./MandateRegistry.sol";
import {IRiskGuard, IVenueAdapter, RiskLimits, TradeTerms, FeeTerms} from "./interfaces/IMandate.sol";

/// @notice Permissionless mandate registration. One transaction deploys a vault from
///         the reviewed MandateVault code, sets its terms on the canonical guard,
///         locks them and catalogs the vault in the registry.
/// @dev The protocol sets the rules and the registrant sets the values
///      (docs/mandate-lifecycle-design.md, principle 4). The rules live in two
///      places: the guard refuses terms outside its version's range (loss cap, mark
///      age, stress, trade terms, fee caps), and this factory adds the ranges only a
///      catalogue can know: which venue adapters exist, and how far leverage and
///      cooldown may go. Nothing here needs the owner's approval per vault; the
///      owner only curates the adapter catalogue.
contract MandateFactory is Ownable {
    error AdapterNotListed(address adapter);
    error InvalidLimits();
    error ZeroAgent();

    /// @notice Leverage ceiling for a factory-made mandate, x100 (20x).
    uint16 public constant MAX_LEVERAGE_X100 = 2_000;
    /// @notice Longest cooldown between trades, in blocks.
    uint32 public constant MAX_COOLDOWN_BLOCKS = 100_000;

    struct MandateParams {
        address agent;
        address adapter;
        RiskLimits limits;
        TradeTerms trade;
        FeeTerms fees;
        bytes32 modelHash;
    }

    IERC20 public immutable asset;
    MandateRiskGuard public immutable guard;
    MandateRegistry public immutable registry;

    mapping(address => bool) public adapterListed;
    address[] private adapters;
    address[] private vaults;
    mapping(address => address) public operatorOf;

    event AdapterListed(address indexed adapter, bool listed);
    event MandateCreated(
        address indexed vault,
        address indexed operator,
        address indexed agent,
        address adapter,
        bytes32 termsHash
    );

    constructor(IERC20 asset_, MandateRiskGuard guard_, MandateRegistry registry_) Ownable(msg.sender) {
        asset = asset_;
        guard = guard_;
        registry = registry_;
    }

    function listAdapter(address adapter, bool listed) external onlyOwner {
        if (listed && !adapterListed[adapter]) adapters.push(adapter);
        adapterListed[adapter] = listed;
        emit AdapterListed(adapter, listed);
    }

    function listedAdapters() external view returns (address[] memory) {
        return adapters;
    }

    /// @notice Create, lock and register a mandate. Anyone may call this; the caller
    ///         is recorded as the operator. When the caller is also `p.agent`, the
    ///         vault is listed under the agent's address at once.
    function createMandate(MandateParams calldata p) external returns (address vault) {
        if (p.agent == address(0)) revert ZeroAgent();
        if (!adapterListed[p.adapter]) revert AdapterNotListed(p.adapter);
        RiskLimits calldata l = p.limits;
        if (
            l.maxLeverageX100 == 0 || l.maxLeverageX100 > MAX_LEVERAGE_X100 ||
            l.minBlocksBetweenTrades > MAX_COOLDOWN_BLOCKS ||
            l.maxOrderNotional == 0 || l.maxPositionNotional == 0 ||
            l.maxTotalNotional == 0 || l.maxBlockNotional == 0 ||
            l.maxOrderNotional > l.maxBlockNotional ||
            l.maxPositionNotional > l.maxTotalNotional
        ) revert InvalidLimits();

        vault = address(new MandateVault(asset, IRiskGuard(address(guard)), p.agent, IVenueAdapter(p.adapter)));
        guard.setAdapter(vault, p.adapter, true);
        guard.configureTerms(vault, p.limits, p.trade, p.fees);
        guard.lockTerms(vault);
        registry.registerFromFactory(vault, p.adapter, p.modelHash, msg.sender);

        vaults.push(vault);
        operatorOf[vault] = msg.sender;
        emit MandateCreated(vault, msg.sender, p.agent, p.adapter, guard.termsHash(vault));
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice Factory-made vaults from `start`, at most `count` of them.
    function vaultsFrom(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 total = vaults.length;
        if (start >= total) return page;
        uint256 end = start + count > total ? total : start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) page[i - start] = vaults[i];
    }
}
