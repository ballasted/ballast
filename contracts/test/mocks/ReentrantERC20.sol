// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 that attempts to reenter a target contract on `transfer`
///         (the outbound leg of decline/reclaim/execute). Used to prove the
///         treasury's nonReentrant guard holds.
contract ReentrantERC20 is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;

    constructor() ERC20("Reentrant", "REENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // Reenter only on an outbound transfer FROM the treasury (from == target).
        if (armed && from == target && target != address(0)) {
            armed = false; // one shot
            (bool ok, bytes memory ret) = target.call(payload);
            // Bubble up the revert reason so the test can assert on it.
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
