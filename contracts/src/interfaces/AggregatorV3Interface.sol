// SPDX-License-Identifier: MIT
// Floating (not exact-pinned): consumed by both the repo's usual 0.8.28
// contracts AND BasketZap.sol, which is pinned to exactly 0.8.26 because it
// imports v4-periphery's V4Router.sol. Pure interface, no version-specific
// syntax, so widening this is safe for every existing consumer.
pragma solidity >=0.8.26 <=0.8.28;

/// @notice Minimal Chainlink AggregatorV3Interface (feed proxy).
/// @dev Read prices via the feed PROXY address. `decimals()` must be read, never
///      hardcoded — most USD feeds are 8 decimals but this is not guaranteed.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
