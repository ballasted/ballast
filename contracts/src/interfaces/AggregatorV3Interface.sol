// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

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
