// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice ERC20 that burns `feeBps` of every transfer/transferFrom amount — the
///         recipient always receives less than the amount specified. Used to prove
///         OpenTreasuryVault credits the amount ACTUALLY received on deposit
///         (balance before/after) and that withdrawals always stay fully covered
///         even when the asset erodes value on every hop (docs/OPEN_TREASURY_DESIGN.md
///         "fee-on-transfer and rebasing assets").
contract FeeOnTransferERC20 is ERC20 {
    uint256 public feeBps; // out of 10_000
    address public feeSink;

    constructor(uint256 feeBps_) ERC20("FeeOnTransfer", "FOT") {
        feeBps = feeBps_;
        feeSink = address(0xFEE);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, feeSink, fee);
    }
}
