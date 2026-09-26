// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAllowanceTransfer — the slice of Permit2's canonical interface BallastRouter
///        needs.
///
/// @notice Canonical address (verified, in use this session): PERMIT2 =
///         0x000000000022D473030F116dDEE9F6B43aC78BA3. This is the SIMPLE,
///         non-signature `approve` path (Permit2's own internal allowance
///         bookkeeping for a spender), not the EIP-712 `permit`/witness path —
///         BallastRouter is always the token OWNER for this call (it already
///         holds the funds by the time it calls this), so there is no separate
///         party to collect a signature from.
interface IAllowanceTransfer {
    /// @notice Set `spender`'s Permit2-tracked allowance to spend `amount` of
    ///         `token` out of the CALLER's (here, BallastRouter's own) balance,
    ///         until `expiration` (unix seconds; 0 = already expired, i.e.
    ///         effectively revoked immediately after use if set to 0 here).
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
