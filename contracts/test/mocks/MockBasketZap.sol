// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BasketLeg} from "../../src/FeeRouter.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Minimal stand-in for BasketZap.swapBasket used by FeeRouter unit tests.
///      On call it MINTS `outPerLeg` of each leg asset to msg.sender (the router —
///      exactly where the real BasketZap sends outputs, since the router is the
///      on-chain creator) and optionally refunds some ETH, so runBasket's
///      delta-deposit + refund + bucket-safety logic can be exercised without a
///      live Fables/Ramses route. The real swap routing is proven in
///      BasketZapFork.t.sol, not here.
contract MockBasketZap {
    uint256 public outPerLeg;
    uint256 public refundWei;

    constructor(uint256 outPerLeg_) {
        outPerLeg = outPerLeg_;
    }

    function setOutPerLeg(uint256 v) external {
        outPerLeg = v;
    }

    function setRefund(uint256 w) external {
        refundWei = w;
    }

    function swapBasket(address, BasketLeg[] calldata legs, uint256)
        external
        payable
        returns (uint256[] memory amountsOut, bool[] memory usedFables)
    {
        uint256 n = legs.length;
        amountsOut = new uint256[](n);
        usedFables = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            MockERC20(legs[i].asset).mint(msg.sender, outPerLeg);
            amountsOut[i] = outPerLeg;
        }
        if (refundWei > 0) {
            (bool s,) = msg.sender.call{value: refundWei}("");
            require(s, "refund fail");
        }
    }

    receive() external payable {}
}
