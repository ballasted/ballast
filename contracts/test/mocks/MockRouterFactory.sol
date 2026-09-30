// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ProjectTreasury} from "../../src/ProjectTreasury.sol";
import {MockRouterToken} from "./MockRouterToken.sol";

/// @notice Stands in for BallastFactory's launch()/graduated() surface (the real
///         factory is frozen and heavy to construct — registry, seeder, ETH/USD
///         feed — none of which FeeRouter's own logic touches). Deploys the REAL
///         ProjectTreasury (not a mock) so treasury-bucket/passthrough tests run
///         against the actual contract FeeRouter will call in production.
contract MockRouterFactory {
    uint256 public constant TICK_SPACING = 60;
    mapping(address => bool) public graduated;
    address public registry;

    constructor(address registry_) {
        registry = registry_;
    }

    function launch(string calldata, string calldata, uint256 noticePeriod, string calldata, address[] calldata)
        external
        returns (uint256 id, address token, address treasury)
    {
        MockRouterToken t = new MockRouterToken(msg.sender);
        ProjectTreasury tr = new ProjectTreasury(address(t), msg.sender, noticePeriod, registry);
        t.setTreasury(address(tr));
        token = address(t);
        treasury = address(tr);
        id = 0;
    }

    function setGraduated(address token, bool value) external {
        graduated[token] = value;
    }
}
