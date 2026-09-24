// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// @title RamsesSwapHelper — minimal, auditable one-shot pool-callback swapper.
///
/// @notice NOT a Ballast protocol contract. Exists only because acquiring NVDA to
///         prove HARUNA's NVDA-quoted pool trades end to end requires spending
///         through the REAL WETH/NVDA liquidity, which sits on a Ramses v3 pool
///         (contracts/../docs/exit-liquidity-table.md), not any Ballast
///         infrastructure. No verified Ramses ROUTER address exists in this repo's
///         research docs, and guessing one is the exact impostor-contract risk
///         CLAUDE.md rule 14 warns about (real money, one shot). A raw
///         IUniswapV3Pool-style pool's `swap()` REQUIRES the caller to be a
///         contract implementing the swap callback (an EOA calling it directly
///         always reverts — the pool checks its own balance delta after the
///         callback) — this contract is exactly that, nothing more: it holds no
///         funds outside a single swap call, takes payment via a pre-approved
///         `transferFrom` on the CALLER (never custodies WETH between calls), and
///         sends 100% of the output directly to `recipient`.
///
/// Never re-used after tonight without re-verifying the pool's identity again —
/// this is a one-off proof, not a standing Ballast dependency.
contract RamsesSwapHelper {
    error NotPool();
    error BadDelta();

    address public immutable pool;
    address public immutable weth;
    address public immutable nvda;

    constructor(address pool_, address weth_, address nvda_) {
        pool = pool_;
        weth = weth_;
        nvda = nvda_;
    }

    /// @notice Spend exactly `amountIn` WETH (pulled from msg.sender via
    ///         transferFrom — caller must approve this contract first) for NVDA,
    ///         sent directly to `recipient`. Reverts if the pool's real output is
    ///         below `minOut`.
    function swapWethForNvda(uint256 amountIn, uint256 minOut, address recipient) external returns (uint256 nvdaOut) {
        // token0=WETH, token1=NVDA on this pool (verified on-chain before use —
        // see the mainnet verification transcript, not assumed here).
        bool zeroForOne = true; // spending token0 (WETH) for token1 (NVDA)
        uint160 sqrtPriceLimitX96 = 4295128740; // TickMath.MIN_SQRT_RATIO + 1 — no floor beyond the pool's own range
        (int256 amount0, int256 amount1) = IUniswapV3PoolActions(pool).swap(
            recipient, zeroForOne, int256(amountIn), sqrtPriceLimitX96, abi.encode(msg.sender)
        );
        nvdaOut = uint256(-amount1);
        require(nvdaOut >= minOut, "insufficient output");
    }

    /// @dev Uniswap-v3-style callback: pay the pool exactly what it says is owed,
    ///      pulled from the ORIGINAL caller (encoded in `data`), never from this
    ///      contract's own balance (it never holds any).
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != pool) revert NotPool();
        address payer = abi.decode(data, (address));
        // Exactly one side is positive (owed to the pool) for an exact-input swap.
        if (amount0Delta > 0) {
            require(IERC20(weth).transferFrom(payer, pool, uint256(amount0Delta)), "weth pay failed");
        } else if (amount1Delta > 0) {
            require(IERC20(nvda).transferFrom(payer, pool, uint256(amount1Delta)), "nvda pay failed");
        } else {
            revert BadDelta();
        }
    }
}

interface IUniswapV3PoolActions {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}
