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
    error AdapterMismatch();
    error NoMarkedEquity();
    error DepositTooSmall(uint256 minimum);

    /// @notice Share of idle assets paid to whoever's poke() first proves a breach.
    /// @dev Gives the freeze the same keeper economics as a liquidation: the vault does
    ///      not rely on the team running a bot for the guarantee to hold.
    uint16 public constant POKE_BOUNTY_BPS = 5;

    /// @notice Shares locked forever out of the first deposit.
    /// @dev Same defence as Uniswap V2's MINIMUM_LIQUIDITY. Without it the first
    ///      depositor can mint one share, transfer cash straight to the vault to push
    ///      the price of that share sky-high, and have every later deposit round down
    ///      to nothing. With MIN_SHARES outstanding that trick costs the attacker
    ///      MIN_SHARES times more than the victim can lose. The locked shares are
    ///      counted in totalSupply, so after the first deposit NAV per share is still
    ///      exactly 1e18, the par the risk guard seeds its high-water mark at.
    uint256 public constant MIN_SHARES = 1e3;
    address public constant LOCKED_SHARES_HOLDER = address(0xdead);

    IERC20 public immutable asset;
    IRiskGuard public immutable riskGuard;
    address public immutable agent;
    /// @notice The venue this vault trades on and is priced against.
    /// @dev One vault, one venue. Pricing shares off adapter A while the agent trades
    ///      on adapter B would value a position the vault cannot see, so execute()
    ///      refuses any other adapter rather than letting the two drift apart.
    IVenueAdapter public immutable venueAdapter;
    AgentState public state = AgentState.Active;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Allocated(address indexed allocator, uint256 assets, uint256 shares);
    event Withdrawn(address indexed allocator, uint256 assets, uint256 shares);
    event Executed(address indexed adapter, bytes32 indexed orderHash, int256 realizedPnl);
    event SharesTransferred(address indexed from, address indexed to, uint256 shares);
    event Frozen(address indexed beneficiary, uint256 bounty);

    constructor(IERC20 asset_, IRiskGuard riskGuard_, address agent_, IVenueAdapter adapter_) {
        asset = asset_;
        riskGuard = riskGuard_;
        agent = agent_;
        venueAdapter = adapter_;
    }

    /// @notice Cash sitting in the vault. This is not what a share is worth.
    /// @dev The adapter reads this as the cash leg of markEquity(), so it cannot be
    ///      made mark-aware itself without recursing. Use markedAssets() for value.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice What the vault is worth: cash plus unrealised PnL on the open position.
    function markedAssets() public view returns (uint256 assets, uint256 markedAt) {
        (assets, markedAt) = venueAdapter.markEquity(address(this));
    }

    function allocate(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert InvalidReceiver();
        if (state != AgentState.Active) revert AgentNotActive();
        if (assets == 0) revert ZeroAmount();

        uint256 supply = totalSupply;
        uint256 locked;
        if (supply == 0) {
            if (assets <= MIN_SHARES) revert DepositTooSmall(MIN_SHARES);
            locked = MIN_SHARES;
            shares = assets - locked;
            balanceOf[LOCKED_SHARES_HOLDER] = locked;
        } else {
            // Price the entry against what the vault is worth, not against the cash it
            // happens to be holding. Minting on the cash balance alone hands a new
            // allocator a slice of an open position's unrealised profit, or charges
            // them for an unrealised loss they were not around for.
            (uint256 equity, uint256 markedAt) = markedAssets();
            riskGuard.requireFreshMark(address(this), markedAt);
            if (equity == 0) revert NoMarkedEquity();
            shares = Math.mulDiv(assets, supply, equity);
        }
        if (shares == 0) revert ZeroShares();

        asset.safeTransferFrom(msg.sender, address(this), assets);
        totalSupply = supply + shares + locked;
        balanceOf[receiver] += shares;
        emit Allocated(receiver, assets, shares);
    }

    /// @notice Redeem shares at marked NAV, paid out of whatever cash the vault holds.
    /// @dev A vault with an open position is not all cash, so a full redemption can be
    ///      worth more than the balance. Rather than revert - which would turn an
    ///      illiquid position into a locked allocator - this pays out the cash it can
    ///      and burns only the shares that cash bought at the marked price. NAV per
    ///      share is unchanged for whoever stays, and the caller keeps the remainder
    ///      of their claim as shares they can redeem once the agent frees up cash.
    function withdraw(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert InvalidReceiver();
        if (shares == 0) revert ZeroShares();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();

        (uint256 equity, uint256 markedAt) = markedAssets();
        riskGuard.requireFreshMark(address(this), markedAt);
        if (equity == 0) revert NoMarkedEquity();

        uint256 supply = totalSupply;
        assets = Math.mulDiv(shares, equity, supply);
        uint256 cash = totalAssets();
        if (assets > cash) {
            assets = cash;
            // Round the burn up so a partial exit never leaves the caller holding a
            // sliver of a share they have already been paid for.
            shares = Math.mulDiv(cash, supply, equity, Math.Rounding.Ceil);
        }
        if (assets == 0) revert ZeroAmount();

        balanceOf[msg.sender] -= shares;
        totalSupply = supply - shares;
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
        if (adapter != address(venueAdapter)) revert AdapterMismatch();

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
