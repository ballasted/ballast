// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Stands in for BallastHook's owed/claim ledger (the real Hook is frozen —
///         see CLAUDE.md — so FeeRouter tests exercise its OWN logic against this
///         instead of redeploying the whole v4 hook stack). Mirrors the real
///         contract's exact semantics: claim()/claimIn() pay and zero msg.sender's
///         own balance only, matching the real Hook's pull-by-address design that
///         FeeRouter's whole "must be the recorded creator" story depends on.
contract MockFeeHook {
    MockERC20 public immutable weth;
    mapping(address => uint256) public owed;
    mapping(address => mapping(address => uint256)) public owedIn;

    constructor(MockERC20 weth_) {
        weth = weth_;
    }

    /// @notice Test helper: credit `recipient` as if a swap fee accrued to them,
    ///         minting the WETH into this contract so claim() has something to pay.
    function credit(address recipient, uint256 amount) external {
        owed[recipient] += amount;
        weth.mint(address(this), amount);
    }

    function creditIn(address recipient, address currency, uint256 amount) external {
        owedIn[recipient][currency] += amount;
        MockERC20(currency).mint(address(this), amount);
    }

    function claim() external returns (uint256 amount) {
        amount = owed[msg.sender];
        owed[msg.sender] = 0;
        if (amount != 0) weth.transfer(msg.sender, amount);
    }

    function claimIn(address currency) external returns (uint256 amount) {
        amount = owedIn[msg.sender][currency];
        owedIn[msg.sender][currency] = 0;
        if (amount != 0) IERC20(currency).transfer(msg.sender, amount);
    }
}
