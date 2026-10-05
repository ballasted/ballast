// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 that attempts to reenter a target contract on the INBOUND leg of
///         a transfer (`to == target`) — the mirror image of ReentrantERC20, which
///         only fires on outbound transfers FROM the target. Needed to test
///         reentrancy on OpenTreasuryVault.deposit(), whose only external call is
///         the inbound `transferFrom` pull — no outbound transfer happens during
///         deposit() for ReentrantERC20's existing `from == target` hook to catch.
contract ReentrantOnReceiveERC20 is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;

    constructor() ERC20("ReentrantOnReceive", "RRECV") {}

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
        if (armed && to == target && target != address(0)) {
            armed = false; // one shot
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
