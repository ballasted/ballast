// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// @title BackingMath — the PERMANENT-effect P0 computation, isolated for fuzzing
///
/// @notice A graduated pool's initial price P0 is immutable. This library derives
///         the floor-aligned opening tick for P0 = (backing per token) / ETH price,
///         so the pool opens at ~1x backing. Pure and self-contained so it can be
///         fuzzed across the whole treasury-value / ETH-price / decimals surface
///         without a fork — a bad rounding at any scale would mis-price a pool
///         forever.
///
/// @dev Flooring (getTickAtSqrtPrice floors to the nearest tick, then we floor to
///      tickSpacing) means the opening price is always <= true 1x backing, never
///      above, bounded below by ~one tickSpacing. Reverts (never returns a garbage
///      tick) if P0 would fall outside v4's usable sqrt-price range.
library BackingMath {
    error P0OutOfRange();

    /// @param backingUsd1e18 total treasury value in USD, 1e18-scaled
    /// @param totalSupply    project token total supply (wei)
    /// @param ethUsd1e18     ETH/USD, 1e18-scaled
    /// @param tickSpacing    pool tick spacing
    /// @return tickLower     floor-aligned opening tick (P0)
    function p0Tick(uint256 backingUsd1e18, uint256 totalSupply, uint256 ethUsd1e18, int24 tickSpacing)
        internal
        pure
        returns (int24 tickLower)
    {
        // backing per WHOLE token, 1e18 USD
        uint256 backingPerToken = FullMath.mulDiv(backingUsd1e18, 1e18, totalSupply);
        // P0 = WETH per token, 1e18 (both WETH and token are 18-decimals)
        uint256 p0 = FullMath.mulDiv(backingPerToken, 1e18, ethUsd1e18);
        if (p0 == 0) revert P0OutOfRange();

        // sqrtPriceX96 = sqrt(P0_ratio) * 2^96 = sqrt(P0_1e18 * 2^192 / 1e18)
        uint256 sqrtP = FixedPointMathLib.sqrt(FullMath.mulDiv(p0, 1 << 192, 1e18));
        if (sqrtP < TickMath.MIN_SQRT_PRICE || sqrtP >= TickMath.MAX_SQRT_PRICE) revert P0OutOfRange();

        int24 tick = TickMath.getTickAtSqrtPrice(uint160(sqrtP));
        int24 rem = tick % tickSpacing;
        if (rem < 0) rem += tickSpacing;
        tickLower = tick - rem;
    }
}
