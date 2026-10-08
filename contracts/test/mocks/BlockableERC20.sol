// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Standard-return ERC20 that reverts transfer()/transferFrom() to any
///         address on its blocklist — simulates a centralized-stablecoin-style
///         denylist (e.g. USDC) blocking one recipient without affecting transfers
///         to anyone else.
contract BlockableERC20 is ERC20 {
    mapping(address => bool) public blocked;

    error Blocked(address account);

    constructor() ERC20("Blockable", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
