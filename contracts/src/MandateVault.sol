// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRiskGuard, IVenueAdapter, IMandateVaultFreeze, TradePreview, FeeTerms} from "./interfaces/IMandate.sol";

contract MandateVault is ReentrancyGuard, IMandateVaultFreeze {
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
    error NotFrozen();
    error UnwindCooldown();
    error TermsNotLocked();
    error ZeroAgent();
    error MarkIsFresh();
    error BelowMinimum(uint256 assets, uint256 minAssets);
    error NoRedeemRequest();
    error RedeemNoticePending(uint256 dueAt);
    error CashCoversRedeem();
    error NothingToDeleverage();
    error SharesUnderRequest();
    error RedemptionDeleveraging(uint256 until);
    error UnwindNotYet(uint256 allowedAt);
    error UnwindStarted();

    /// @notice Share of idle assets paid to whoever's poke() first proves a breach.
    /// @dev Gives the freeze the same keeper economics as a liquidation: the vault does
    ///      not rely on the team running a bot for the guarantee to hold.
    uint16 public constant POKE_BOUNTY_BPS = 5;

    /// @notice How many unwind() calls it takes to close a frozen position.
    /// @dev Each step closes one fifth of the size the vault was frozen with, one step
    ///      per block, so a close is spread over blocks instead of hitting the venue in
    ///      one print. Five is a starting point, to be revisited against real fills
    ///      once a production venue adapter exists.
    uint8 public constant UNWIND_STEPS = 5;

    /// @notice Share of idle assets paid to whoever lands an unwind() step.
    /// @dev 0.01% per step, 0.05% for the full close: the same keeper economics as the
    ///      poke bounty, so nobody has to be trusted to finish what the freeze started.
    uint16 public constant UNWIND_BOUNTY_BPS = 1;

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
    /// @notice unwind() steps landed so far; UNWIND_STEPS means the position is gone.
    uint8 public unwindStepsDone;
    uint256 public lastUnwindBlock;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    /// @notice NAV per share above which the next performance fee is charged.
    /// @dev Starts at par and only moves up, and only when a fee is taken against it.
    /// @notice How long the agent has, after an allocator asks to redeem, to free the
    ///         cash for it before anyone may take positions off the book to do so.
    uint256 public constant REDEEM_NOTICE = 1 days;
    /// @notice After a forced deleverage, how long orders that add exposure stay
    ///         refused, so the cash it freed is still there when the allocator comes.
    uint256 public constant REDEEM_GRACE = 1 hours;
    /// @notice A forced deleverage closes this much more than the shortfall it computes,
    ///         for the fee and the fill on the way out.
    uint16 public constant DELEVERAGE_BUFFER_BPS = 500;

    struct RedeemRequest {
        uint256 shares;
        uint64 requestedAt;
    }

    /// @notice Shares each allocator has asked to redeem and when. They stay the
    ///         allocator's and keep earning or losing with the vault until withdrawn,
    ///         but they cannot be transferred while the request stands.
    mapping(address => RedeemRequest) public redeemRequestOf;
    /// @notice Until this time the agent may only reduce exposure.
    uint64 public riskLockedUntil;

    uint256 public feeHighWaterNavPerShare = 1e18;
    /// @notice When fees were last accrued; 0 before the first deposit.
    uint256 public lastFeeAccrual;

    event Allocated(address indexed allocator, uint256 assets, uint256 shares);
    event Withdrawn(address indexed allocator, uint256 assets, uint256 shares);
    event WithdrawnUnpriced(address indexed allocator, uint256 assets, uint256 shares);
    event Executed(address indexed adapter, bytes32 indexed orderHash, int256 realizedPnl);
    event SharesTransferred(address indexed from, address indexed to, uint256 shares);
    event Frozen(address indexed beneficiary, uint256 bounty);
    event Unwound(address indexed caller, uint8 step, uint256 closedNotional, int256 realizedPnl, uint256 bounty);
    event Closed();
    event Resumed();
    event RedeemRequested(address indexed allocator, uint256 shares, uint256 dueAt);
    event RedeemCancelled(address indexed allocator);
    event DeleveragedForRedemption(
        address indexed allocator, address indexed caller, uint16 fractionBps, uint256 closedNotional, int256 realizedPnl
    );
    event FeesAccrued(address indexed agent, uint256 managementAssets, uint256 performanceAssets, uint256 shares);

    constructor(IERC20 asset_, IRiskGuard riskGuard_, address agent_, IVenueAdapter adapter_) {
        // The other three constructor args are typed as contracts: calling a
        // real method on the zero address reverts on first use, so a bad value
        // fails loud. `agent_` is only ever compared with `==`, so a zero value
        // would not fail at all -- it would just quietly deploy a vault no one
        // can ever call execute() on.
        if (agent_ == address(0)) revert ZeroAgent();
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

    /// @dev markedAssets(), but a venue that cannot be read at all counts as a mark that
    ///      never happened (0, 0) instead of reverting. A dead venue must not also close
    ///      the freeze and the cash-only exit, which exist for exactly that case.
    function _tryMarkedAssets() private view returns (uint256 assets, uint256 markedAt) {
        try venueAdapter.markEquity(address(this)) returns (uint256 a, uint256 at) {
            return (a, at);
        } catch {
            return (0, 0);
        }
    }

    function allocate(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert InvalidReceiver();
        if (state != AgentState.Active) revert AgentNotActive();
        // Money only goes in behind terms the owner can no longer rewrite. This is the
        // line that turns "read the terms" into "the terms you read are the terms".
        if (!riskGuard.termsLocked(address(this))) revert TermsNotLocked();
        if (assets == 0) revert ZeroAmount();

        _accrueFees();
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
        if (supply == 0) lastFeeAccrual = block.timestamp;
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

        _accrueFees();
        uint256 equity;
        if (state == AgentState.Closed) {
            // A Closed vault holds no position, so no price can change what a share is
            // worth and a stale mark has nothing left to misprice. Nor may a venue that
            // has since stopped answering lock the cash in: when its views revert, the
            // vault's own balance prices the share, and anything still parked at the
            // venue stays with the shares that remain.
            (equity,) = _tryMarkedAssets();
            if (equity == 0) equity = totalAssets();
        } else {
            uint256 markedAt;
            (equity, markedAt) = markedAssets();
            riskGuard.requireFreshMark(address(this), markedAt);
        }
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
        _fillRequest(msg.sender, shares);
        asset.safeTransfer(receiver, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /// @notice Exit a frozen vault whose mark has stopped, for cash alone.
    /// @dev withdraw() prices shares off a fresh mark, and a vault frozen because its
    ///      venue went quiet has none; unwinding it may also need the venue back. Rather
    ///      than hold allocators until it returns, this pays the shares' pro-rata slice
    ///      of the vault's cash, capped at what they were worth at the guard's last
    ///      mark, and burns them. The caller gives up their part of whatever is still
    ///      at the venue to the allocators who stay, so this never moves value from
    ///      the ones who stay to the one who leaves, except for any loss since the
    ///      last mark that the cap cannot see (the cap is as of the last poke or
    ///      trade). It is the exit of last resort: once the mark is fresh again, or
    ///      the vault is Closed, withdraw() pays the full share. A frozen vault with
    ///      nothing left at the venue closes on its first unwind() step, which is the
    ///      better exit there.
    function withdrawUnpriced(uint256 shares, address receiver, uint256 minAssets)
        external nonReentrant returns (uint256 assets)
    {
        if (receiver == address(0)) revert InvalidReceiver();
        if (shares == 0) revert ZeroShares();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        if (state != AgentState.Frozen) revert NotFrozen();
        (, uint256 markedAt) = _tryMarkedAssets();
        try riskGuard.requireFreshMark(address(this), markedAt) {
            revert MarkIsFresh();
        } catch {}

        uint256 supply = totalSupply;
        assets = Math.mulDiv(shares, totalAssets(), supply);
        (,, uint128 lastNav) = riskGuard.dayOf(address(this));
        if (lastNav != 0) {
            uint256 atLastMark = Math.mulDiv(shares, lastNav, 1e18);
            if (atLastMark < assets) assets = atLastMark;
        }
        if (assets == 0) revert ZeroAmount();
        if (assets < minAssets) revert BelowMinimum(assets, minAssets);

        balanceOf[msg.sender] -= shares;
        totalSupply = supply - shares;
        _fillRequest(msg.sender, shares);
        asset.safeTransfer(receiver, assets);
        emit WithdrawnUnpriced(msg.sender, assets, shares);
    }

    /// @notice Move only the caller's shares; no approval or agent spending authority.
    /// @dev Remains available while Frozen so batch claims preserve withdrawal rights.
    function transferShares(address receiver, uint256 shares) external nonReentrant {
        if (receiver == address(0)) revert InvalidReceiver();
        if (shares == 0) revert ZeroShares();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        if (balanceOf[msg.sender] - redeemRequestOf[msg.sender].shares < shares) revert SharesUnderRequest();
        balanceOf[msg.sender] -= shares;
        balanceOf[receiver] += shares;
        emit SharesTransferred(msg.sender, receiver, shares);
    }

    function execute(address adapter, bytes calldata order) external nonReentrant {
        if (msg.sender != agent) revert OnlyAgent();
        if (state != AgentState.Active) revert AgentNotActive();
        if (adapter != address(venueAdapter)) revert AdapterMismatch();

        _accrueFees();
        TradePreview memory expected = IVenueAdapter(adapter).preview(address(this), order);
        if (block.timestamp < riskLockedUntil && _addsRisk(adapter, expected)) {
            revert RedemptionDeleveraging(riskLockedUntil);
        }
        riskGuard.checkAndConsumeBefore(address(this), adapter, expected);
        // A venue that holds margin (PerplAdapter) pulls what the order needs from the
        // vault's cash during the call. The allowance exists only inside this frame,
        // and only for the one adapter the vault was built with.
        asset.forceApprove(adapter, totalAssets());
        (int256 realizedPnl,) = IVenueAdapter(adapter).execute(address(this), order);
        asset.forceApprove(adapter, 0);
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
    ///      The position is not touched here: closing it is unwind()'s job, and a
    ///      freeze must not depend on a fill going through. Not `nonReentrant`:
    ///      it is reached from inside execute()'s guarded frame, and also from
    ///      poke() and freezeUnobservable(), which are not. State is written
    ///      before the single ERC20 transfer, so a second bounty is impossible.
    function freeze(address beneficiary) external returns (uint256 bounty) {
        if (msg.sender != address(riskGuard)) revert OnlyRiskGuard();
        if (state != AgentState.Active) revert AgentNotActive();
        // Charge what accrued up to the freeze, then never again: accrual only runs
        // while Active.
        _accrueFees();
        state = AgentState.Frozen;

        bounty = (totalAssets() * POKE_BOUNTY_BPS) / 10_000;
        if (bounty > 0 && beneficiary != address(0)) {
            asset.safeTransfer(beneficiary, bounty);
        } else {
            bounty = 0;
        }
        emit Frozen(beneficiary, bounty);
    }

    /// @notice Frozen -> Active, for a freeze the guard has cleared.
    /// @dev Only the RiskGuard may call, and it allows this only for an unobservable
    ///      freeze whose mark is fresh again. Once unwind() has taken a step the
    ///      position is no longer the agent's, so the vault cannot come back. Fees
    ///      restart from now: nothing accrues for the time the agent was stopped.
    function resume() external {
        if (msg.sender != address(riskGuard)) revert OnlyRiskGuard();
        if (state != AgentState.Frozen) revert NotFrozen();
        if (unwindStepsDone != 0) revert UnwindStarted();
        state = AgentState.Active;
        if (lastFeeAccrual != 0) lastFeeAccrual = block.timestamp;
        emit Resumed();
    }

    /// @notice Ask for `shares` more to be redeemable in cash within REDEEM_NOTICE.
    /// @dev withdraw() pays out of the cash in the vault, and on a venue that holds
    ///      margin an open position can leave too little of it. The request is the
    ///      notice the agent gets to free that cash on its own terms; once it is due,
    ///      deleverageForRedemption() lets anyone free it instead. Adding to a request
    ///      restarts its notice, so an agent always sees the full amount in time.
    function requestRedeem(uint256 shares) external {
        if (shares == 0) revert ZeroShares();
        RedeemRequest storage request = redeemRequestOf[msg.sender];
        uint256 total = request.shares + shares;
        if (total > balanceOf[msg.sender]) revert InsufficientShares();
        request.shares = total;
        request.requestedAt = uint64(block.timestamp);
        emit RedeemRequested(msg.sender, total, block.timestamp + REDEEM_NOTICE);
    }

    function cancelRedeem() external {
        if (redeemRequestOf[msg.sender].shares == 0) revert NoRedeemRequest();
        delete redeemRequestOf[msg.sender];
        emit RedeemCancelled(msg.sender);
    }

    /// @notice Take enough of the position off the book to pay a redemption that is due.
    /// @dev Permissionless, one step per block, Active vaults only: a Frozen vault is
    ///      being unwound already. Runs only when the request is past its notice and
    ///      the vault's cash is short of the shares' marked value. It closes the same
    ///      fraction of every position, sized as the shortfall over what the vault has
    ///      at the venue plus DELEVERAGE_BUFFER_BPS, through the adapter's reduce-only
    ///      path and its slippage bound. For REDEEM_GRACE after, the agent may only
    ///      reduce exposure, so the freed cash waits for the allocator. Nothing is
    ///      paid to the caller: the allocator who is owed the cash is the one who calls.
    function deleverageForRedemption(address allocator) external nonReentrant returns (uint16 fractionBps) {
        if (state != AgentState.Active) revert AgentNotActive();
        RedeemRequest memory request = redeemRequestOf[allocator];
        if (request.shares == 0) revert NoRedeemRequest();
        uint256 dueAt = uint256(request.requestedAt) + REDEEM_NOTICE;
        if (block.timestamp < dueAt) revert RedeemNoticePending(dueAt);
        // Shares unwind()'s per-block slot: the two never run in the same state.
        if (lastUnwindBlock == block.number) revert UnwindCooldown();
        lastUnwindBlock = block.number;

        _accrueFees();
        (uint256 equity, uint256 markedAt) = markedAssets();
        riskGuard.requireFreshMark(address(this), markedAt);
        uint256 claim = Math.mulDiv(request.shares, equity, totalSupply);
        uint256 cash = totalAssets();
        if (claim <= cash) revert CashCoversRedeem();
        if (equity <= cash) revert NothingToDeleverage();

        uint256 bps = Math.mulDiv(claim - cash, 10_000 + DELEVERAGE_BUFFER_BPS, equity - cash, Math.Rounding.Ceil);
        fractionBps = bps >= 10_000 ? 10_000 : uint16(bps);
        (uint256 closedNotional, int256 realizedPnl) = venueAdapter.reduce(address(this), fractionBps);
        if (closedNotional == 0) revert NothingToDeleverage();
        riskLockedUntil = uint64(block.timestamp + REDEEM_GRACE);
        emit DeleveragedForRedemption(allocator, msg.sender, fractionBps, closedNotional, realizedPnl);

        // Re-mark as after any fill: the guard keeps its holding clock and drawdown
        // current, and may freeze here if the exit itself crossed a limit.
        riskGuard.checkAfter(address(this), address(venueAdapter));
    }

    /// @notice Charge the fees accrued since the last accrual. Permissionless.
    function accrueFees() external nonReentrant returns (uint256 shares) {
        return _accrueFees();
    }

    /// @notice Fees that accrueFees() would charge now, in assets, and the shares it
    ///         would mint for them.
    function pendingFees()
        public
        view
        returns (uint256 managementAssets, uint256 performanceAssets, uint256 shares, uint256 navAfter)
    {
        uint256 supply = totalSupply;
        if (state != AgentState.Active || supply == 0 || lastFeeAccrual == 0) return (0, 0, 0, 0);
        FeeTerms memory fee = riskGuard.feesOf(address(this));
        if (fee.managementFeeBps == 0 && fee.performanceFeeBps == 0) return (0, 0, 0, 0);
        (uint256 equity, uint256 markedAt) = _tryMarkedAssets();
        if (equity == 0) return (0, 0, 0, 0);
        // Fees are charged on a mark the guard would trade against, never on a stale one.
        try riskGuard.requireFreshMark(address(this), markedAt) {} catch {
            return (0, 0, 0, 0);
        }

        uint256 elapsed = block.timestamp - lastFeeAccrual;
        managementAssets = Math.mulDiv(equity, uint256(fee.managementFeeBps) * elapsed, 10_000 * 365 days);
        uint256 nav = Math.mulDiv(equity, 1e18, supply);
        if (nav > feeHighWaterNavPerShare && fee.performanceFeeBps != 0) {
            uint256 gain = Math.mulDiv(nav - feeHighWaterNavPerShare, supply, 1e18);
            performanceAssets = Math.mulDiv(gain, fee.performanceFeeBps, 10_000);
        }
        uint256 total = managementAssets + performanceAssets;
        if (total == 0 || total >= equity) return (0, 0, 0, nav);
        // Mint so the new shares are worth exactly the fee at today's NAV:
        // shares / (supply + shares) = total / equity.
        shares = Math.mulDiv(total, supply, equity - total);
        navAfter = Math.mulDiv(equity, 1e18, supply + shares);
    }

    /// @dev Fees are paid in new shares to the agent, never in cash, so a fee never
    ///      competes with an allocator's withdrawal for the vault's cash.
    function _accrueFees() private returns (uint256 shares) {
        if (state != AgentState.Active || lastFeeAccrual == 0) return 0;
        (uint256 managementAssets, uint256 performanceAssets, uint256 minted, uint256 navAfter) = pendingFees();
        if (navAfter == 0) return 0; // stale or unpriced mark: try again later, nothing lost
        lastFeeAccrual = block.timestamp;
        // A new high, net of this fee, is the bar for the next performance fee.
        if (navAfter > feeHighWaterNavPerShare) feeHighWaterNavPerShare = navAfter;
        if (minted == 0) return 0;
        uint256 supply = totalSupply;
        totalSupply = supply + minted;
        balanceOf[agent] += minted;
        riskGuard.onFeeMint(supply, supply + minted);
        emit FeesAccrued(agent, managementAssets, performanceAssets, minted);
        return minted;
    }

    /// @notice Close one fifth of a frozen vault's position and pay the caller.
    /// @dev Permissionless, one step per block. A freeze stops the agent but leaves the
    ///      position open, and a stopped agent cannot reduce it; without this the loss
    ///      keeps running and, on a venue that holds margin, allocators can only redeem
    ///      the cash left in the vault. Steps close 1/5, 1/4, 1/3, 1/2 and then all of
    ///      what remains, so five steps take the size at freeze off the book in equal
    ///      slices. When nothing is left the vault moves Frozen -> Closed, which is
    ///      terminal: no trades, no deposits, withdrawals only.
    function unwind() external nonReentrant returns (bool closed) {
        if (state != AgentState.Frozen) revert NotFrozen();
        uint256 allowedAt = riskGuard.unwindAllowedAt(address(this));
        if (block.timestamp < allowedAt) revert UnwindNotYet(allowedAt);
        if (lastUnwindBlock == block.number) revert UnwindCooldown();
        lastUnwindBlock = block.number;

        uint256 closedNotional;
        int256 realizedPnl;
        uint8 step = unwindStepsDone;
        (uint256 positionNotional,) = venueAdapter.positionState(address(this));
        if (positionNotional != 0) {
            uint256 stepsLeft = step < UNWIND_STEPS ? UNWIND_STEPS - step : 1;
            (closedNotional, realizedPnl) =
                venueAdapter.reduce(address(this), uint16(10_000 / stepsLeft));
            step += 1;
            unwindStepsDone = step;
            (positionNotional,) = venueAdapter.positionState(address(this));
        }

        // Paid for closing size only: a call that finds the book already flat just
        // moves the vault to Closed and earns nothing.
        uint256 bounty = closedNotional == 0 ? 0 : (totalAssets() * UNWIND_BOUNTY_BPS) / 10_000;
        if (bounty > 0) asset.safeTransfer(msg.sender, bounty);
        emit Unwound(msg.sender, step, closedNotional, realizedPnl, bounty);

        if (positionNotional == 0) {
            state = AgentState.Closed;
            emit Closed();
            closed = true;
        }
    }

    /// @dev Burned shares count against the caller's request first.
    function _fillRequest(address allocator, uint256 shares) private {
        uint256 requested = redeemRequestOf[allocator].shares;
        if (requested == 0) return;
        if (shares >= requested) delete redeemRequestOf[allocator];
        else redeemRequestOf[allocator].shares = requested - shares;
    }

    /// @dev The guard's definition: more total exposure, or a crossing through flat.
    function _addsRisk(address adapter, TradePreview memory expected) private view returns (bool) {
        (, uint256 totalBefore) = IVenueAdapter(adapter).positionState(address(this));
        return expected.expectedTotalNotional > totalBefore ||
            (expected.currentSizeE18 > 0 && expected.resultingSizeE18 < 0) ||
            (expected.currentSizeE18 < 0 && expected.resultingSizeE18 > 0);
    }
}
