// SPDX-License-Identifier: MIT
pragma solidity >=0.8.26 <=0.8.28; // widened: also imported by BasketZap.t.sol (0.8.26)

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal WETH9-compatible mock — just `deposit()`, the only surface
///         BasketZap (and BallastV1Claim) needs.
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}
