// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPerplExchange} from "./IPerplExchange.sol";

/// @notice One vault's account on Perpl. Perpl keys accounts by msg.sender, so each
///         vault needs an address of its own; PerplAdapter deploys one per vault.
/// @dev Only the adapter that deployed it can move anything, and collateral can
///      leave only to the vault it was made for.
contract PerplSubaccount {
    using SafeERC20 for IERC20;

    error OnlyAdapter();

    address public immutable adapter;
    address public immutable vault;
    IPerplExchange public immutable exchange;
    IERC20 public immutable collateral;

    constructor(address vault_, IPerplExchange exchange_, IERC20 collateral_) {
        adapter = msg.sender;
        vault = vault_;
        exchange = exchange_;
        collateral = collateral_;
    }

    modifier onlyAdapter() {
        if (msg.sender != adapter) revert OnlyAdapter();
        _;
    }

    /// @notice Move `amount` of the collateral this contract holds into its Perpl
    ///         account, opening the account on first use.
    function fund(uint256 amount, bool open) external onlyAdapter {
        collateral.forceApprove(address(exchange), amount);
        if (open) exchange.createAccount(amount);
        else exchange.depositCollateral(amount);
    }

    function order(IPerplExchange.OrderDesc calldata desc) external onlyAdapter {
        exchange.execOrder(desc);
    }

    /// @notice Withdraw from the Perpl account and send it to the vault.
    function release(uint256 amount) external onlyAdapter {
        exchange.withdrawCollateral(amount);
        collateral.safeTransfer(vault, collateral.balanceOf(address(this)));
    }
}
