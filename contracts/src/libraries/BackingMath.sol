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
///
///      The token is ALSO not guaranteed currency0 (v4 requires currency0 <
///      currency1 by address, and dropping CREATE2 mining left that ordering
///      unconstrained — see OrderingLib). A v4 tick always means currency1/
///      currency0, so when the token sorts as currency1 the raw ratio computed
///      below must be INVERTED before the sqrt/tick step, and the conservative
///      rounding direction (never open above true backing) flips with it: an
///      inverted ratio's tick runs opposite the real price, so token=currency1
///      must round the tick UP, not down, to stay <= true backing.
library BackingMath {
    error P0OutOfRange();

    /// @param backingUsd1e18   total treasury value in USD, 1e18-scaled
    /// @param totalSupply      project token total supply (wei) — always
    ///                         18-decimal, this is Ballast's own token,
    ///                         constrained by construction
    /// @param quotePrice1e18   the pool's quote asset, USD per WHOLE unit, 1e18-scaled
    /// @param quoteDecimals    the quote asset's own decimals() (18 for WETH; may
    ///                         differ for other quote assets, e.g. 6 for USDC)
    /// @param tickSpacing      pool tick spacing
    /// @param tokenIsCurrency0 true if the launched token sorts below the quote
    ///                         asset for THIS pool (see OrderingLib.tokenIsCurrency0)
    /// @return openTick        tick-spacing-aligned opening tick, in true
    ///                         currency1/currency0 terms, conservative in either
    ///                         ordering (real price at open <= true 1x backing)
    function p0Tick(
        uint256 backingUsd1e18,
        uint256 totalSupply,
        uint256 quotePrice1e18,
        uint8 quoteDecimals,
        int24 tickSpacing,
        bool tokenIsCurrency0
    ) internal pure returns (int24 openTick) {
        // backing per WHOLE token, 1e18 USD
        uint256 backingPerToken = FullMath.mulDiv(backingUsd1e18, 1e18, totalSupply);
        // P0 = quote asset per WHOLE token, 1e18 fixed point (a whole-unit ratio,
        // not yet raw-unit — see the decimals note above).
        uint256 p0 = FullMath.mulDiv(backingPerToken, 1e18, quotePrice1e18);
        if (p0 == 0) revert P0OutOfRange();

        // Raw-unit ratio (quoteRaw per tokenRaw): scale the whole-unit ratio by
        // the quote asset's decimals (the token side is always 18-decimal, so
        // only this side needs the term). quoteDecimals=18 makes this a no-op.
        uint256 p0Raw = FullMath.mulDiv(p0, 10 ** quoteDecimals, 1e18);
        if (p0Raw == 0) revert P0OutOfRange();

        // p0Raw is a 1e18-fixed representation of quoteRaw/tokenRaw. That IS the
        // pool's currency1/currency0 raw ratio when the token is currency0; when
        // the token is currency1 the pool's raw ratio is the reciprocal
        // (tokenRaw/quoteRaw), so invert here rather than let the tick math run
        // backwards.
        uint256 rawRatio1e18 = tokenIsCurrency0 ? p0Raw : FullMath.mulDiv(1e18, 1e18, p0Raw);
        if (rawRatio1e18 == 0) revert P0OutOfRange();

        // sqrtPriceX96 = sqrt(ratio) * 2^96 = sqrt(rawRatio1e18 * 2^192 / 1e18)
        uint256 sqrtP = FixedPointMathLib.sqrt(FullMath.mulDiv(rawRatio1e18, 1 << 192, 1e18));
        if (sqrtP < TickMath.MIN_SQRT_PRICE || sqrtP >= TickMath.MAX_SQRT_PRICE) revert P0OutOfRange();

        // getTickAtSqrtPrice always FLOORS to the integer tick grid (the largest
        // tick T with getSqrtPriceAtTick(T) <= sqrtP), regardless of ordering.
        // For tokenIsCurrency0 that floor is already the conservative direction
        // we want, so flooring again to tickSpacing composes cleanly. For the
        // ceiling branch it does NOT compose for free: flooring to the tick grid
        // can already sit up to ~1 tick below the true continuous value, and
        // ceiling THAT to tickSpacing only guarantees >= the floored tick, not
        // >= the true value — so `tick + 1` undoes the grid floor first,
        // guaranteeing we ceil from a point already at or above the true tick.
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(sqrtP));
        if (!tokenIsCurrency0) tick += 1;
        int24 rem = tick % tickSpacing;
        if (tokenIsCurrency0) {
            // Floor: real price (quote/token) moves WITH the raw tick here, so
            // rounding the tick down keeps the opening price at or below backing.
            if (rem < 0) rem += tickSpacing;
        } else {
            // Ceil: real price (quote/token) moves OPPOSITE the raw tick here
            // (it's 1/ratio), so rounding the tick down would round the real
            // price UP past true backing — round up instead.
            if (rem > 0) rem -= tickSpacing;
        }
        openTick = tick - rem;
    }
}
