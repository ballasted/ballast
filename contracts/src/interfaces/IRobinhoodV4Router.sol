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
///   - `minHopPriceX36` has TWO shapes depending on the action:
///       * SWAP_EXACT_IN_SINGLE → scalar `uint256` (enabled iff `!= 0`)
///       * SWAP_EXACT_IN (multi-hop) → `uint256[]` (length 0 to disable, else it
///         MUST equal the number of hops or the router reverts InvalidHopPriceLength)
///   - "X36" = fixed-point scaled by 10^36 (a minimum execution price per hop).
///   - Disable the check with 0 (single) or an empty array (multi-hop).
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
///   SWAP_EXACT_IN        = 0x07
///   SETTLE_ALL           = 0x0c
///   TAKE_ALL             = 0x0f
///
/// The V4_SWAP input is abi.encode(bytes actions, bytes[] params), where params[0]
/// is the swap struct below, params[1] SETTLE_ALL args, params[2] TAKE_ALL args.
library RobinhoodV4 {
    bytes1 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACT_SWAP_EXACT_IN = 0x07;
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

    /// @notice MULTI-hop swap params. Here `minHopPriceX36` is an ARRAY, one entry
    ///         per hop; length MUST be 0 (disabled) or exactly `path.length`, else
    ///         the router reverts `InvalidHopPriceLength`.
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    // ⚠️ Field order verified against the deployed contract's Blockscout source
    // (IV4Router.sol). minHopPriceX36 sits THIRD — after `path`, BEFORE `amountIn`.
    // (It is NOT trailing; getting this wrong mis-encodes every multi-hop swap.)
    struct ExactInputParams {
        address currencyIn; // Currency in v4
        PathKey[] path;
        uint256[] minHopPriceX36; // FORK-ONLY, 3rd field. empty = disabled; else length == path.length.
        uint128 amountIn;
        uint128 amountOutMinimum;
    }
}
