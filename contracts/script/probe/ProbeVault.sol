// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// @notice The most minimal contract that can custody an ERC-20. Used by the
///         Session 0 probe to answer the existential question for BALLAST: can a
///         *contract* (not an EOA) receive, hold, and transfer out a Robinhood
///         Stock Token?
///
/// @dev Deliberately dumb and raw. It does NOT use SafeERC20 — we want the exact
///      result of each call: a raw `bool` when the token returns one, or a revert
///      we can read. It exercises BOTH transfer paths, separately:
///
///        - PUSH: an EOA calls `token.transfer(vault, amount)` directly (tested in
///          the script, not here).
///        - PULL: `pull()` calls `transferFrom` from inside the contract — this is
///          the treasury's REAL deposit path (`ProjectTreasury.deposit` /
///          `proposeDeposit` both use `safeTransferFrom`). If a stock token has a
///          holder allowlist that excludes contracts on the receiving side, or
///          blocks contract-initiated `transferFrom`, this is where it shows.
contract ProbeVault {
    /// @notice The vault's own balance of `token`.
    function heldBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice PULL path: pull `amount` from `from` into this contract. Requires
    ///         `from` to have approved this vault first. Returns the token's raw
    ///         bool so the caller can tell "returned false" from "reverted".
    function pull(address token, address from, uint256 amount) external returns (bool ok) {
        ok = IERC20(token).transferFrom(from, address(this), amount);
    }

    /// @notice Re-callable sweep: moves the ENTIRE current balance out via a raw
    ///         `transfer`. Safe to call repeatedly — it re-reads the balance each
    ///         time, so it works whether the vault holds a push, a pull, or both.
    function sweep(address token, address to) external returns (uint256 amount, bool ok) {
        amount = IERC20(token).balanceOf(address(this));
        ok = IERC20(token).transfer(to, amount);
    }
}
