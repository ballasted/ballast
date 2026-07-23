// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IRobinhoodV4Router — the MODIFIED UniversalRouter on Robinhood Chain
///
/// @notice ⚠️ This chain's UniversalRouter is a FORK. Its v4 swap params carry an
///         extra `minHopPriceX36` field that stock Uniswap SDK calldata omits — so
///         SDK-generated calldata REVERTS. This file is the canonical, independently
///         verified reference for the encoding; the factory/swap code must build
///         calldata to match it exactly, never via the stock SDK.
///
/// VERIFIED 2026-07-23 (docs/robinhood-chain-research.md §4):
///   - Address: 0x8876789976dEcBfCbBbe364623C63652db8C0904 — confirmed on
///     Blockscout as a verified fork of Uniswap universal-router + v4-periphery.
///     TWO look-alike routers exist on this chain; only this address has the
///     matching verified fork source. Verify again before sending value.
///   - `minHopPriceX36` on SWAP_EXACT_IN_SINGLE is a scalar `uint256` (enabled iff
///     `!= 0`). "X36" = fixed-point scaled by 10^36 (a minimum execution price).
///     Disable it with 0 and rely on `amountOutMinimum`.
///   - BALLAST ships SINGLE-HOP ONLY. Graduated pools are token/WETH (one hop);
///     native ETH is handled by a separate WRAP/UNWRAP command, and the treasury
///     side never swaps. The multi-hop `ExactInputParams` shape (where
///     `minHopPriceX36` is a `uint256[]`, 3rd field after `path`) EXISTS and is
///     verified-from-source — see research §4 — but is deliberately NOT carried
///     here: untested code in the most error-prone spot is pure attack surface.
///
/// @dev Uses plain `address` where v4 uses its `Currency`/`IHooks` wrapper types
///      (identical ABI encoding). When the factory is built, swap these for the
///      real v4-core types; the byte layout is unchanged.
interface IRobinhoodV4Router {
    /// @notice UniversalRouter entrypoint. `commands` is a byte string of command
    ///         ids; `inputs[i]` is the ABI-encoded input for command i. Use a
    ///         TIMESTAMP deadline (this chain has ~100ms blocks).
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Command id for a v4 swap inside UniversalRouter.execute.
///   V4_SWAP = 0x10
///
/// @notice v4 Actions (the sub-encoding inside a V4_SWAP input):
///   SWAP_EXACT_IN_SINGLE = 0x06
///   SETTLE_ALL           = 0x0c
///   TAKE_ALL             = 0x0f
///   (SWAP_EXACT_IN = 0x07 is multi-hop — not shipped; see note above.)
///
/// The V4_SWAP input is abi.encode(bytes actions, bytes[] params), where params[0]
/// is the swap struct below, params[1] SETTLE_ALL args, params[2] TAKE_ALL args.
library RobinhoodV4 {
    bytes1 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACT_SETTLE_ALL = 0x0c;
    uint8 internal constant ACT_TAKE_ALL = 0x0f;

    /// @notice v4 PoolKey (unchanged from stock v4).
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @notice SINGLE-hop swap params — this is what BALLAST needs for a graduated
    ///         token/WETH pool. `minHopPriceX36` is the FORK addition (scalar),
    ///         sitting AFTER `amountOutMinimum` and BEFORE `hookData`. Set it to 0
    ///         to disable (rely on `amountOutMinimum` for slippage).
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36; // FORK-ONLY. 0 = disabled.
        bytes hookData;
    }

    // Multi-hop (ExactInputParams / PathKey, with minHopPriceX36 as a uint256[])
    // is intentionally omitted — BALLAST is single-hop only. The verified shape is
    // recorded in docs/robinhood-chain-research.md §4 if it is ever needed.
}
