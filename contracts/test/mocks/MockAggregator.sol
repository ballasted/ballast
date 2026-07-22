// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

/// @notice Configurable Chainlink feed mock. Also used as the sequencer uptime
///         feed, where `answer` is the status (0 = up) and `startedAt` is the last
///         status-change time.
contract MockAggregator is AggregatorV3Interface {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    bool private _revertOnRead;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        _decimals = decimals_;
        _answer = answer_;
        _updatedAt = updatedAt_;
        _startedAt = updatedAt_;
    }

    function setAnswer(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function setStartedAt(uint256 startedAt_) external {
        _startedAt = startedAt_;
    }

    function setRevert(bool r) external {
        _revertOnRead = r;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        require(!_revertOnRead, "feed down");
        return (1, _answer, _startedAt, _updatedAt, 1);
    }
}
