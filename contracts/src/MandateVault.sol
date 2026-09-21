// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRiskGuard, IVenueAdapter, TradePreview} from "./interfaces/IMandate.sol";

contract MandateVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum AgentState { Active, Frozen, Closed }

    error OnlyAgent();
    error AgentNotActive();
    error ZeroAmount();
    error ZeroShares();
    error ResultMismatch();
    error InsufficientShares();
    error InvalidReceiver();
    error OnlyRiskGuard();

    /// @notice Share of idle assets paid to whoever's poke() first proves a breach.
    /// @dev Gives the freeze the same keeper economics as a liquidation: the vault does
    ///      not rely on the team running a bot for the guarantee to hold.
    uint16 public constant POKE_BOUNTY_BPS = 5;

    IERC20 public immutable asset;
    IRiskGuard public immutable riskGuard;
    address public immutable agent;
    AgentState public state = AgentState.Active;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Allocated(address indexed allocator, uint256 assets, uint256 shares);
    event Withdrawn(address indexed allocator, uint256 assets, uint256 shares);
    event Executed(address indexed adapter, bytes32 indexed orderHash, int256 realizedPnl);
    event SharesTransferred(address indexed from, address indexed to, uint256 shares);
    event Frozen(address indexed beneficiary, uint256 bounty);

    constructor(IERC20 asset_, IRiskGuard riskGuard_, address agent_) {
        asset = asset_;
        riskGuard = riskGuard_;
        agent = agent_;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function allocate(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert InvalidReceiver();
        if (state != AgentState.Active) revert AgentNotActive();
        if (assets == 0) revert ZeroAmount();
        uint256 assetsBefore = totalAssets();
        shares = totalSupply == 0 ? assets : Math.mulDiv(assets, totalSupply, assetsBefore);
        if (shares == 0) revert ZeroShares();

        asset.safeTransferFrom(msg.sender, address(this), assets);
        totalSupply += shares;
        balanceOf[receiver] += shares;
        emit Allocated(receiver, assets, shares);
    }

    function withdraw(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert InvalidReceiver();
        if (shares == 0) revert ZeroShares();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        assets = Math.mulDiv(shares, totalAssets(), totalSupply);
        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        asset.safeTransfer(receiver, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /// @notice Move only the caller's shares; no approval or agent spending authority.
    /// @dev Remains available while Frozen so batch claims preserve withdrawal rights.
    function transferShares(address receiver, uint256 shares) external nonReentrant {
        if (receiver == address(0)) revert InvalidReceiver();
        if (shares == 0) revert ZeroShares();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        balanceOf[msg.sender] -= shares;
        balanceOf[receiver] += shares;
        emit SharesTransferred(msg.sender, receiver, shares);
    }

    function execute(address adapter, bytes calldata order) external nonReentrant {
        if (msg.sender != agent) revert OnlyAgent();
        if (state != AgentState.Active) revert AgentNotActive();

        TradePreview memory expected = IVenueAdapter(adapter).preview(address(this), order);
        riskGuard.checkAndConsumeBefore(address(this), adapter, expected);
        (int256 realizedPnl,) = IVenueAdapter(adapter).execute(address(this), order);
        (uint256 positionNotional, uint256 totalNotional) =
            IVenueAdapter(adapter).positionState(address(this));

        if (
            positionNotional != expected.expectedPositionNotional ||
            totalNotional != expected.expectedTotalNotional
        ) revert ResultMismatch();

        emit Executed(adapter, expected.orderHash, realizedPnl);

        // Re-mark after the fill. Without this the vault is only ever valued at the
        // moment the agent chooses to trade.
        riskGuard.checkAfter(address(this), adapter);
    }

    /// @notice Stop the agent and pay the caller who proved the breach.
    /// @dev Only the RiskGuard may call. Withdrawals stay open while Frozen so
    ///      allocators keep their exit; only allocate() and execute() are closed.
    ///      Deliberately not `nonReentrant`: it is reached from inside execute()'s
    ///      guarded frame. State is written before the single ERC20 transfer.
    function freeze(address beneficiary) external returns (uint256 bounty) {
        if (msg.sender != address(riskGuard)) revert OnlyRiskGuard();
        if (state != AgentState.Active) revert AgentNotActive();
        state = AgentState.Frozen;

        bounty = (totalAssets() * POKE_BOUNTY_BPS) / 10_000;
        if (bounty > 0 && beneficiary != address(0)) {
            asset.safeTransfer(beneficiary, bounty);
        } else {
            bounty = 0;
        }
        emit Frozen(beneficiary, bounty);
    }
}
