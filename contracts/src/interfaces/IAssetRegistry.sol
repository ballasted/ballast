// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAssetRegistry
/// @notice Read interface for the global BALLAST asset allowlist.
/// @dev Assets are keyed by canonical contract address only — never by ticker or
///      name. Same-ticker impostor tokens are a documented risk on Robinhood Chain
///      (see docs/robinhood-chain-research.md §2), so lookups must be address-exact.
interface IAssetRegistry {
    /// @notice Whether `asset` may be deposited into any treasury.
    function isAllowed(address asset) external view returns (bool);

    /// @notice Minimum deposit size for `asset`, in the asset's own decimals.
    /// @dev Enforced to stop dust-spam from bloating valuation loops and griefing
    ///      gas on view functions.
    function minDeposit(address asset) external view returns (uint256);

    /// @notice Chainlink feed proxy for `asset` (AggregatorV3Interface).
    function feedOf(address asset) external view returns (address);

    /// @notice Per-asset staleness bound in seconds. A tokenized T-bill and a
    ///         tokenized equity need different bounds, so this is per asset, never
    ///         a single global constant.
    function staleAfter(address asset) external view returns (uint256);
}
