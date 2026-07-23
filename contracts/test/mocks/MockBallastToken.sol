// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal stand-in for a launched project token in hook fork tests:
///         exposes creator() (the hook reads it to credit the creator's fee share)
///         and mints a large supply for seeding pool liquidity.
contract MockBallastToken is ERC20 {
    address public immutable creator;

    constructor(address creator_) ERC20("Mock Ballast", "MBAL") {
        creator = creator_;
        _mint(msg.sender, 1_000_000_000e18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
