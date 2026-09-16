// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// @title BackingMath — the PERMANENT-effect P0 computation, isolated for fuzzing
///
/// @notice A graduated pool's initial price P0 is immutable. This library derives
///         the floor-aligned opening tick for P0 = (backing per token) / quote-asset
///         price, so the pool opens at ~1x backing. Pure and self-contained so it
///         can be fuzzed across the whole treasury-value / quote-price / decimals
///         surface without a fork — a bad rounding at any scale would mis-price a
///         pool forever.
///
/// @dev Flooring (getTickAtSqrtPrice floors to the nearest tick, then we floor to
///      tickSpacing) means the opening price is always <= true 1x backing, never
///      above, bounded below by ~one tickSpacing. Reverts (never returns a garbage
///      tick) if P0 would fall outside v4's usable sqrt-price range.
///
///      The quote asset is NOT guaranteed 18-decimal (WETH is; USDC and the
///      stock/ETF quote options are not all the same as each other) — `p0` below
///      is a WHOLE-unit ratio (quote per whole token, 1e18 fixed point), and
///      sqrtPriceX96 needs a RAW-unit ratio. Those two are only equal when both
///      sides happen to be 18-decimal, which is why the old single-quote-asset
///      version of this function never needed the `quoteDecimals` scaling term
///      that turns the whole-unit ratio into the raw one.
library BackingMath {
    error P0OutOfRange();

    /// @param backingUsd1e18 total treasury value in USD, 1e18-scaled
    /// @param totalSupply    project token total supply (wei) — always 18-decimal,
    ///                       this is Ballast's own token, constrained by construction
    /// @param quotePrice1e18 the pool's quote asset, USD per WHOLE unit, 1e18-scaled
    /// @param quoteDecimals  the quote asset's own decimals() (18 for WETH; may
    ///                       differ for other quote assets, e.g. 6 for USDC)
    /// @param tickSpacing    pool tick spacing
    /// @return tickLower     floor-aligned opening tick (P0)
    function p0Tick(
        uint256 backingUsd1e18,
        uint256 totalSupply,
        uint256 quotePrice1e18,
        uint8 quoteDecimals,
        int24 tickSpacing
    ) internal pure returns (int24 tickLower) {
        // backing per WHOLE token, 1e18 USD
        uint256 backingPerToken = FullMath.mulDiv(backingUsd1e18, 1e18, totalSupply);
        // P0 = quote asset per WHOLE token, 1e18 fixed point (a whole-unit ratio,
        // not yet raw-unit — see the decimals note above).
        uint256 p0 = FullMath.mulDiv(backingPerToken, 1e18, quotePrice1e18);
        if (p0 == 0) revert P0OutOfRange();

        // Raw-unit ratio: scale the whole-unit ratio by the quote asset's decimals
        // (the token side is always 18-decimal, so only this side needs the term).
        // quoteDecimals=18 makes this a no-op, matching the original single-asset
        // behavior exactly.
        uint256 p0Raw = FullMath.mulDiv(p0, 10 ** quoteDecimals, 1e18);
        if (p0Raw == 0) revert P0OutOfRange();

        // sqrtPriceX96 = sqrt(P0_ratio) * 2^96 = sqrt(P0Raw_1e18 * 2^192 / 1e18)
        uint256 sqrtP = FixedPointMathLib.sqrt(FullMath.mulDiv(p0Raw, 1 << 192, 1e18));
        if (sqrtP < TickMath.MIN_SQRT_PRICE || sqrtP >= TickMath.MAX_SQRT_PRICE) revert P0OutOfRange();

        int24 tick = TickMath.getTickAtSqrtPrice(uint160(sqrtP));
        int24 rem = tick % tickSpacing;
        if (rem < 0) rem += tickSpacing;
        tickLower = tick - rem;
    }
}
