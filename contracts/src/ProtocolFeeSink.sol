// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAssetRegistryLike {
    function isAllowed(address asset) external view returns (bool);
}

/// @title ProtocolFeeSink — the protocol's share of Ramses-locked splitter fees,
///        routed by token identity: quote assets to the Safe, launched tokens burned
///
/// @notice Set as `protocolRecipient` on every BallastFeeSplitter created by the
///         factory this is wired into (see BallastFeeSplitterFactory). Any token
///         that lands here — pushed by a splitter's `distribute()`, or paid in
///         directly — is routed by `flush()`: WETH and any AssetRegistry-listed
///         stock token goes to the Safe; everything else (the launched token on
///         the other side of that pool, $BALLAST, or anything else) is sent to
///         the dead address. Mirrors the project's existing buy/burn philosophy
///         (BuybackBurnerV2) rather than letting the Safe accumulate raw balances
///         of every launched token it ever touched a fee of.
///
/// @dev No owner, no admin, no pause, no upgrade path, no rescue/sweep. All three
///      addresses are immutable, set once at construction. `flush()` is
///      permissionless and balance-based — it holds nothing between calls (the
///      full balance it finds is always moved out in the same call, to exactly
///      one of two fixed destinations, never a caller-supplied one).
contract ProtocolFeeSink {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable weth;
    address public immutable safe;
    IAssetRegistryLike public immutable registry;

    event Flushed(address indexed token, uint256 amount, address indexed destination, bool burned);

    error ZeroAddress();
    error NothingToFlush();

    constructor(address weth_, address safe_, address registry_) {
        if (weth_ == address(0) || safe_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        weth = weth_;
        safe = safe_;
        registry = IAssetRegistryLike(registry_);
    }

    /// @notice Moves this contract's ENTIRE balance of `token` to its one fixed
    ///         destination for that token: the Safe for WETH or any
    ///         AssetRegistry-listed stock token, otherwise the dead address.
    function flush(address token) external returns (uint256 amount, address destination, bool burned) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToFlush();

        burned = !(token == weth || registry.isAllowed(token));
        destination = burned ? DEAD : safe;

        IERC20(token).safeTransfer(destination, amount);
        emit Flushed(token, amount, destination, burned);
    }
}
