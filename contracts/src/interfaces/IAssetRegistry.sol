// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Market-hours class for an asset's feed, taken from the Chainlink
///         `marketHours` field at allowlist time. Drives the off-chain two-tier
///         freshness classification (RESTING vs STALE) — see web/lib/marketHours.ts.
enum MarketHours {
    Unknown, // no class recorded
    UsEquities24_5, // "us_equities_24/5": trades ~24h Sun 8pm ET → Fri 8pm ET
    Crypto24_7 // always open
}

/// @title IAssetRegistry
/// @notice Read interface for the global BALLAST asset allowlist.
/// @dev Assets are keyed by canonical contract address only — never by ticker or
///      name. Same-ticker impostor tokens are a documented risk on Robinhood Chain
///      (see docs/robinhood-chain-research.md §2), so lookups must be address-exact.
interface IAssetRegistry {
    /// @notice Whether `asset` may be deposited into any treasury.
    function isAllowed(address asset) external view returns (bool);

    /// @notice Minimum deposit size for `asset`, in the asset's own decimals.
    function minDeposit(address asset) external view returns (uint256);

    /// @notice Chainlink feed proxy for `asset`. MUST be the Standard Proxy, never
    ///         the SVR (Smart Value Recapture) proxy (CLAUDE.md rule 15).
    function feedOf(address asset) external view returns (address);

    /// @notice Per-asset absolute staleness bound in seconds. This is the OUTER
    ///         safety net (a resting feed may legitimately reach it over a long
    ///         weekend/holiday). The fine RESTING-vs-STALE distinction during
    ///         trading hours is computed off-chain from `marketHoursOf` + updatedAt.
    function staleAfter(address asset) external view returns (uint256);

    /// @notice Market-hours class of the asset's feed.
    function marketHoursOf(address asset) external view returns (MarketHours);
}
