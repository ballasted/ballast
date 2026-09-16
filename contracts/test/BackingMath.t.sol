// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BackingMath} from "../src/libraries/BackingMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @dev Pure fuzz of the PERMANENT-effect P0 math across the whole supported
///      treasury-value / ETH-price surface. No fork per run, so it explores
///      thousands of points cheaply. Invariants: the pool opens at <= 1x backing
///      (flooring, never above) and within a tight, stated band below; P0 never
///      rounds to zero or leaves v4's sqrt-price range (reverts loudly instead of
///      returning a garbage tick).
contract BackingMathTest is Test {
    uint256 constant S = 1_000_000_000e18; // 1B supply
    int24 constant TS = 60;
    uint8 constant QD = 18; // WETH-parity quote decimals — every pre-existing test below

    // Guaranteed tolerance: one tickSpacing (1.0001^60 - 1 ≈ 0.602%) plus tick/sqrt
    // truncation. We assert the pool opens no more than 0.7% below 1x backing and
    // never above it.
    uint256 constant LOWER_BOUND_BPS = 9930; // 0.70% below allowed
    uint256 constant BPS = 10_000;

    function _expectedP0(uint256 backingUsd, uint256 ethUsd) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(backingUsd, 1e18, S), 1e18, ethUsd);
    }

    function _poolP0(int24 tick) internal pure returns (uint256) {
        uint160 sp = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(uint256(sp) * uint256(sp), 1e18, 1 << 192);
    }

    /// forge-config: default.fuzz.runs = 5000
    function testFuzz_opensWithinToleranceOfBacking(uint256 backingUsd, uint256 ethUsd) public pure {
        backingUsd = bound(backingUsd, 1e18, 50_000_000e18); // $1 .. $50M treasury
        ethUsd = bound(ethUsd, 50e18, 20_000e18); // $50 .. $20k per ETH

        int24 tick = BackingMath.p0Tick(backingUsd, S, ethUsd, QD, TS); // must not revert in-range
        uint256 poolP0 = _poolP0(tick);
        uint256 expected = _expectedP0(backingUsd, ethUsd);

        // Never opens ABOVE 1x backing (flooring is one-sided).
        assertLe(poolP0, expected + 1, "opened above 1x backing");
        // Never more than 0.70% below.
        assertGe(poolP0, FullMath.mulDiv(expected, LOWER_BOUND_BPS, BPS), "opened >0.70% below 1x");
        // Never rounds to a degenerate tick.
        assertGt(poolP0, 0, "P0 rounded to zero");
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_feeDecimalsInvariant_backingScalesLinearly(uint256 units, uint256 ethUsd) public pure {
        // Whatever the feed decimals, the factory hands BackingMath a 1e18-scaled
        // USD value; doubling that value must move P0 to exactly ~2x (monotonic, no
        // decimal-driven cliff).
        uint256 v = bound(units, 1e18, 10_000_000e18);
        ethUsd = bound(ethUsd, 50e18, 20_000e18);
        int24 t1 = BackingMath.p0Tick(v, S, ethUsd, QD, TS);
        int24 t2 = BackingMath.p0Tick(v * 2, S, ethUsd, QD, TS);
        assertGe(t2, t1, "higher backing must not lower P0");
        // ~2x = +ln(2)/ln(1.0001) ticks = ~6931; allow tick-flooring slack (2 spacings).
        assertApproxEqAbs(int256(t2) - int256(t1), int256(6931), 120, "2x backing != ~2x price");
    }

    /// External wrapper so vm.expectRevert sees the internal library revert at a
    /// lower call depth.
    function extP0(uint256 b, uint256 e) external pure returns (int24) {
        return BackingMath.p0Tick(b, S, e, QD, TS);
    }

    function test_extremeValues_revertNotGarbage() public {
        // Absurdly large backing -> reverts LOUDLY (FullMath overflow), never a
        // garbage tick.
        vm.expectRevert();
        this.extP0(1e60, 1e18);
        // Tiny P0 (huge ETH price vs dust backing) -> our explicit P0OutOfRange.
        vm.expectRevert(BackingMath.P0OutOfRange.selector);
        this.extP0(1e18, type(uint256).max / 1e19);
    }

    /// Regression: an 18-decimal quote asset must produce IDENTICAL output to the
    /// pre-generalization single-quote-asset version — quoteDecimals=18 has to be a
    /// true no-op, not just "close."
    function test_eighteenDecimalQuote_matchesOriginalBehavior() public pure {
        uint256 backingUsd = 5_000_000e18;
        uint256 quotePrice = 3_000e18;
        int24 tick = BackingMath.p0Tick(backingUsd, S, quotePrice, 18, TS);
        uint256 expected = _expectedP0(backingUsd, quotePrice);
        uint256 poolP0 = _poolP0(tick);
        assertLe(poolP0, expected + 1);
        assertGe(poolP0, FullMath.mulDiv(expected, LOWER_BOUND_BPS, BPS));
    }

    /// The actual target case this generalization exists for: a 6-decimal quote
    /// asset (USDC-shaped). Proves the raw-unit scaling term is correct, not just
    /// "doesn't revert" — checked against an independently-computed expected raw
    /// ratio, not the library's own intermediate value.
    /// forge-config: default.fuzz.runs = 3000
    function testFuzz_sixDecimalQuote_scalesRawRatioCorrectly(uint256 backingUsd, uint256 quotePrice) public pure {
        // A 6-decimal quote asset shrinks the raw ratio by another 1e12 on top of
        // the whole-unit one. Below a certain backing/quotePrice combination,
        // integer division on p0Raw itself loses enough precision that even a
        // NON-zero result carries >0.7% truncation error — a tolerance-check
        // artifact, not a contract bug (P0OutOfRange, tested separately, is what
        // covers the truly-degenerate zero case). $1M+ backing against a
        // USDC-realistic $0.50-$2 band keeps p0Raw large enough (>=500 at the
        // worst-case corner) that truncation error stays well under the 0.70%
        // tolerance this test asserts.
        backingUsd = bound(backingUsd, 1_000_000e18, 50_000_000e18); // $1M .. $50M treasury
        quotePrice = bound(quotePrice, 0.5e18, 2e18); // $0.50 .. $2 per whole quote unit
        uint8 quoteDecimals = 6;

        int24 tick = BackingMath.p0Tick(backingUsd, S, quotePrice, quoteDecimals, TS);
        uint256 poolP0Raw = _poolP0(tick);

        uint256 wholeUnitRatio = FullMath.mulDiv(FullMath.mulDiv(backingUsd, 1e18, S), 1e18, quotePrice);
        uint256 expectedRaw = FullMath.mulDiv(wholeUnitRatio, 10 ** quoteDecimals, 1e18);

        assertLe(poolP0Raw, expectedRaw + 1, "opened above 1x backing (6-decimal quote)");
        assertGe(poolP0Raw, FullMath.mulDiv(expectedRaw, LOWER_BOUND_BPS, BPS), "opened >0.70% below (6-decimal quote)");
        assertGt(poolP0Raw, 0, "P0 rounded to zero");
    }
}
