// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The ERC-8056 (Scaled UI Amount) surface of a Robinhood Stock Token.
/// @dev Stock tokens are ordinary 18-decimal ERC-20s. Corporate actions do NOT
///      change balances — they move `uiMultiplier()`. See
///      docs/robinhood-chain-research.md §2.
///
///      CRITICAL: never apply `uiMultiplier()` to a Chainlink feed price. The feed
///      already returns the full multiplier-adjusted per-token price; applying it
///      again double-counts and inflates every backing figure. `uiMultiplier()` is
///      only for converting to underlying-share terms for display.
interface IStockToken {
    /// @notice 18-decimal fixed point; 1e18 = 1.0. Advisory for display only.
    function uiMultiplier() external view returns (uint256);

    /// @notice True while a corporate action is processing. Advisory (Chainlink
    ///         states it is not enforced on-chain); treat `updatedAt` as the
    ///         primary staleness guard and this as a secondary UI signal.
    function oraclePaused() external view returns (bool);

    /// @notice Pending corporate action, readable in advance.
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);

    /// @notice ERC-8056 UI-amount helpers: balance/supply scaled by the multiplier
    ///         for display. NOTE: for valuation, use the Chainlink feed price (which
    ///         already includes the multiplier) — never multiply by these.
    function balanceOfUI(address account) external view returns (uint256);
    function totalSupplyUI() external view returns (uint256);
}
