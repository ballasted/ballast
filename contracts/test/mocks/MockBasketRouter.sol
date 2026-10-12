// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {MockBasketPermit2} from "./MockBasketPermit2.sol";

/// @notice Mock UniversalRouter for BasketZap unit tests. Does not simulate a
///         real pool — it pulls exactly the settled WETH amount via the mock
///         Permit2 (mirroring the real router's settlement path: BasketZap
///         approves Permit2, Permit2 moves the ERC20, never the router
///         directly) and pays out a per-asset configurable amount, so every
///         revert path (minOut not met, a leg reverting outright) can be
///         driven directly without needing real liquidity. The real
///         swap-execution encoding is proven separately against live pools in
///         the mainnet fork suite (test/BasketZapFork.t.sol).
contract MockBasketRouter {
    MockBasketPermit2 public immutable permit2;

    mapping(address asset => uint256) public outAmount;
    mapping(address asset => bool) public shouldRevert;

    error MockLegReverted(address asset);

    constructor(address permit2_) {
        permit2 = MockBasketPermit2(permit2_);
    }

    function setOutAmount(address asset, uint256 amount) external {
        outAmount[asset] = amount;
    }

    function setShouldRevert(address asset, bool r) external {
        shouldRevert[asset] = r;
    }

    /// @dev `inputs[0]` is `abi.encode(bytes actions, bytes[] params)` where
    ///      `params[1]` is SETTLE_ALL's `(currency, amount)` and `params[2]` is
    ///      TAKE_ALL's `(currency, minAmount)` — see IRobinhoodV4Router.sol.
    ///      This mock only needs those two, never the swap struct itself.
    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address settleCurrency, uint256 settleAmount) = abi.decode(params[1], (address, uint256));
        (address takeCurrency,) = abi.decode(params[2], (address, uint256));

        if (shouldRevert[takeCurrency]) revert MockLegReverted(takeCurrency);

        permit2.routerPull(msg.sender, settleCurrency, settleAmount);

        uint256 out = outAmount[takeCurrency];
        if (out > 0) {
            IERC20(takeCurrency).transfer(msg.sender, out);
        }
    }
}
