// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Permit2 stand-in for BasketZap's unit tests. Real Permit2
///         tracks its OWN internal (owner, token, spender) allowance, separate
///         from the ERC20-level allowance the owner grants to Permit2 itself —
///         this mirrors exactly that two-layer model: `approve()` records the
///         internal allowance, `routerPull()` (called by the mock router, which
///         is "the spender") moves tokens via `transferFrom`, which only
///         succeeds because the owner separately did a plain ERC20
///         `forceApprove(permit2, amount)` before calling `approve()` here —
///         the exact sequence BasketZap._swapLeg performs.
contract MockBasketPermit2 {
    mapping(address owner => mapping(address token => mapping(address spender => uint256))) public allowance;

    error InsufficientAllowance();

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[msg.sender][token][spender] = amount;
    }

    /// @dev Called by a mock router (the recorded spender) to actually move
    ///      `amount` of `token` out of `owner`'s balance.
    function routerPull(address owner, address token, uint256 amount) external {
        uint256 allowed = allowance[owner][token][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        allowance[owner][token][msg.sender] = allowed - amount;
        IERC20(token).transferFrom(owner, msg.sender, amount);
    }
}
