// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice An ERC20 whose transfer hook tries to re-enter the vault holding it.
/// @dev MockUSDC is honest and cannot exercise this path, so this stand-in exists
///      only to prove MandateVault's nonReentrant guards hold even when the asset
///      itself is malicious (mandate-technical-spec-v0.2.md 7: "malicious
///      adapter/token fuzzing").
contract MaliciousReentrantToken is ERC20 {
    address public target;
    bytes public reentrantCall;
    bool public armed;

    constructor() ERC20("Evil", "EVIL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata call_) external {
        target = target_;
        reentrantCall = call_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && target != address(0)) {
            // One-shot: clear before the recursive call so it cannot re-fire itself.
            armed = false;
            (bool ok, bytes memory ret) = target.call(reentrantCall);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
