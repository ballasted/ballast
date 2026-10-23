// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IBallastRouterV2 {
    function buyWithETH(
        uint256[] calldata fablesHopIdx,
        uint256[] calldata ramsesHopIdx,
        bool preferFables,
        address quoteAsset,
        address ballastToken,
        address hook,
        uint256 minOut,
        uint256 deadline
    ) external payable returns (uint256 out, bool usedFables);

    function sellToETH(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        uint256[] calldata fablesHopIdx,
        uint256[] calldata ramsesHopIdx,
        bool preferFables,
        uint256 minOut,
        uint256 deadline
    ) external returns (uint256 out, bool usedFables);
}

/// @title RoundupMainAdapter
/// @notice The RoundupRouter `IMainSwapRouter` adapter — a thin wrapper over the
///         deployed, already-proven BallastRouterV2 so the trader's MAIN leg runs
///         exactly as it does today (the gen-4 hook fee applies unchanged). Buys
///         deliver the token to the trader; sells return ETH to the caller
///         (RoundupRouter).
/// @dev    No owner, holds no funds between calls.
///
///         SCOPE LIMITATION: BallastRouterV2.buyWithETH/sellToETH cover the
///         ETH-via-Fables/Ramses ROUTED path (tokens paired against a non-WETH
///         quote asset — SGOV/NVDA/SPY). Tokens paired directly against WETH (the
///         common case) trade through the app's direct v4 path, NOT BallastRouterV2,
///         so they are NOT covered by this adapter. For those, either (a) a
///         second direct-v4 main adapter is needed, or (b) — recommended — keep the
///         main swap on the app's existing proven path and batch it with a
///         stock-only round-up call via EIP-5792 (the app already uses EIP-5792),
///         so RoundupRouter never needs to re-implement the main swap at all. See
///         docs/security/roundups.md.
///
///         ⚠️ NOT fork-tested on 4663 (no paid RPC in the build env) nor audited.
///         Required before use.
contract RoundupMainAdapter {
    using SafeERC20 for IERC20;

    IBallastRouterV2 public immutable router;

    error ZeroAddress();

    constructor(address router_) {
        if (router_ == address(0)) revert ZeroAddress();
        router = IBallastRouterV2(router_);
    }

    receive() external payable {}

    /// @param route abi.encode(address quoteAsset, address hook, uint256[] fablesHopIdx, uint256[] ramsesHopIdx, bool preferFables, uint256 deadline)
    function buy(address token, address trader, uint256 minOut, bytes calldata route)
        external
        payable
        returns (uint256 out)
    {
        (
            address quoteAsset,
            address hook,
            uint256[] memory fablesHopIdx,
            uint256[] memory ramsesHopIdx,
            bool preferFables,
            uint256 deadline
        ) = abi.decode(route, (address, address, uint256[], uint256[], bool, uint256));

        (out,) = router.buyWithETH{value: msg.value}(
            fablesHopIdx, ramsesHopIdx, preferFables, quoteAsset, token, hook, minOut, deadline
        );
        // BallastRouterV2 delivers the token to THIS adapter (msg.sender); forward it.
        IERC20(token).safeTransfer(trader, IERC20(token).balanceOf(address(this)));
    }

    /// @param route abi.encode(address quoteAsset, address hook, uint256[] fablesHopIdx, uint256[] ramsesHopIdx, bool preferFables, uint256 deadline)
    function sell(address token, address trader, uint256 amountIn, uint256 minOut, bytes calldata route)
        external
        returns (uint256 ethOut)
    {
        (
            address quoteAsset,
            address hook,
            uint256[] memory fablesHopIdx,
            uint256[] memory ramsesHopIdx,
            bool preferFables,
            uint256 deadline
        ) = abi.decode(route, (address, address, uint256[], uint256[], bool, uint256));

        // Pull the token from the caller (RoundupRouter) and approve the router.
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(token).forceApprove(address(router), amountIn);
        (ethOut,) = router.sellToETH(
            token, amountIn, quoteAsset, hook, fablesHopIdx, ramsesHopIdx, preferFables, minOut, deadline
        );
        IERC20(token).forceApprove(address(router), 0);

        // sellToETH sends the ETH proceeds to this adapter (its msg.sender); forward
        // the whole balance to the caller (RoundupRouter passes trader = itself).
        (bool ok,) = trader.call{value: address(this).balance}("");
        require(ok, "eth forward failed");
    }
}
