// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";

interface IDescribed {
    function description() external view returns (string memory);
}

/// @title InspectFeed — read-only Chainlink feed inspector (no key, no gas, no state change)
///
/// @notice Prints latestRoundData price, decimals, updatedAt, age, and whether
///         BALLAST's staleAfter logic would flag it stale *right now*. Point it at
///         a feed's STANDARD proxy (never the SVR proxy — CLAUDE.md rule 15).
///
/// Required env:
///   FEED_PROXY        — the Standard Proxy address of the feed
/// Optional env:
///   FEED_STALE_AFTER  — staleness bound in seconds (default 259200 = 3 days, so a
///                       us_equities_24/5 feed survives a weekend)
///
/// Run (read-only, no --broadcast):
///   forge script script/InspectFeed.s.sol:InspectFeed --rpc-url robinhood_mainnet
contract InspectFeed is Script {
    function run() external view {
        address feedAddr = vm.envAddress("FEED_PROXY");
        uint256 staleAfter = vm.envOr("FEED_STALE_AFTER", uint256(259200));
        AggregatorV3Interface feed = AggregatorV3Interface(feedAddr);

        console2.log("=== Chainlink feed inspection ===");
        console2.log("feed (proxy):   ", feedAddr);
        try IDescribed(feedAddr).description() returns (string memory d) {
            console2.log("description:    ", d);
        } catch {
            console2.log("description:     <none>");
        }

        uint8 dec = feed.decimals();
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();

        console2.log("decimals:       ", dec);
        console2.log("answer (raw):   ", answer);
        console2.logString(_scaled(answer, dec));
        console2.log("roundId:        ", roundId);
        console2.log("startedAt:      ", startedAt);
        console2.log("updatedAt:      ", updatedAt);
        console2.log("answeredInRound:", answeredInRound);
        console2.log("block.timestamp:", block.timestamp);

        require(answer > 0, "answer <= 0: invalid price (would be excluded from totals)");

        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        console2.log("age (s):        ", age);
        console2.log("staleAfter (s): ", staleAfter);
        console2.log("would flag stale now:", age > staleAfter);
        console2.log("(stale still counts toward backing; it is a flag, never a revert)");
    }

    function _scaled(int256 answer, uint8 dec) internal pure returns (string memory) {
        if (answer <= 0) return "price (USD):     n/a";
        uint256 a = uint256(answer);
        uint256 unit = 10 ** dec;
        uint256 whole = a / unit;
        uint256 frac = ((a % unit) * 100) / unit; // 2dp
        return string.concat("price (USD):     ~$", vm.toString(whole), ".", _pad2(frac));
    }

    function _pad2(uint256 v) internal pure returns (string memory) {
        return v < 10 ? string.concat("0", vm.toString(v)) : vm.toString(v);
    }
}
