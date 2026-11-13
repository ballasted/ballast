// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IGen5HookClaim {
    function claim(address currency) external returns (uint256);
    function owed(address recipient, address currency) external view returns (uint256);
}

/// @title ProtocolFeeVault — the protocol 20% sink on Elysium (testnet design)
///
/// @notice Accrues the protocol share of every gen-5 swap fee (BallastHookV5 credits
///         this contract's address 20% of each fee, in the pool's quote asset) and can
///         move those funds to EXACTLY ONE fixed destination, set once at deploy and
///         never changeable. There is NO owner, NO admin, NO upgrade, NO rescue, and
///         NO path that sends value anywhere other than `destination`.
///
/// @dev This is the simplest safe cross-chain-burn primitive for TESTNET (brief item g):
///      a vault with no owner-withdrawal, only a forward-to-one-address. On mainnet the
///      destination becomes whatever the chosen bridge→BuybackBurnerV2 design wires up
///      (see docs/elysium-burn-design.md) — but that decision is the human's, and this
///      contract deliberately encodes none of it beyond "funds can only ever go to the
///      one address burned in at construction."
///
///      Both entrypoints are permissionless and pull-based: anyone may `collect` the
///      hook's owed balance into this vault and `forward` it onward. Permissionless is
///      safe precisely because the funds have exactly one possible exit.
contract ProtocolFeeVault {
    using SafeERC20 for IERC20;

    /// @notice The gen-5 hook that credits this vault its protocol share.
    address public immutable hook;
    /// @notice The ONLY address this vault can ever send funds to. Immutable.
    address public immutable destination;

    event Collected(address indexed currency, uint256 amount);
    event Forwarded(address indexed currency, address indexed destination, uint256 amount);

    error ZeroAddress();

    constructor(address hook_, address destination_) {
        if (hook_ == address(0) || destination_ == address(0)) revert ZeroAddress();
        hook = hook_;
        destination = destination_;
    }

    /// @notice Pull this vault's owed `currency` out of the hook into this vault.
    ///         Permissionless. No-op-safe (hook.claim returns 0 if nothing owed).
    function collect(address currency) public returns (uint256 amount) {
        amount = IGen5HookClaim(hook).claim(currency);
        if (amount != 0) emit Collected(currency, amount);
    }

    /// @notice Send this vault's entire `currency` balance to the fixed destination.
    ///         Permissionless. The only way value ever leaves this contract.
    function forward(address currency) public returns (uint256 amount) {
        amount = IERC20(currency).balanceOf(address(this));
        if (amount != 0) {
            IERC20(currency).safeTransfer(destination, amount);
            emit Forwarded(currency, destination, amount);
        }
    }

    /// @notice Convenience: collect from the hook then forward onward, one call.
    function sweep(address currency) external returns (uint256 forwarded) {
        collect(currency);
        return forward(currency);
    }
}
