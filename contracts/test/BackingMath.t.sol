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

        int24 tick = BackingMath.p0Tick(backingUsd, S, ethUsd, TS); // must not revert in-range
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
        int24 t1 = BackingMath.p0Tick(v, S, ethUsd, TS);
        int24 t2 = BackingMath.p0Tick(v * 2, S, ethUsd, TS);
        assertGe(t2, t1, "higher backing must not lower P0");
        // ~2x = +ln(2)/ln(1.0001) ticks = ~6931; allow tick-flooring slack (2 spacings).
        assertApproxEqAbs(int256(t2) - int256(t1), int256(6931), 120, "2x backing != ~2x price");
    }

    /// External wrapper so vm.expectRevert sees the internal library revert at a
    /// lower call depth.
    function extP0(uint256 b, uint256 e) external pure returns (int24) {
        return BackingMath.p0Tick(b, S, e, TS);
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

    // ── unbackedTick: WETH-denominated opening FDV (no oracle) ──────────────────

    /// The concrete values the factory ships with: 5 ETH -> -191160 (the number that
    /// must never be hand-entered again), and the retired 1 ETH -> -207300. Both are
    /// floor-aligned to TS, same convention as backed P0.
    function test_unbackedTick_concreteValues() public pure {
        assertEq(BackingMath.unbackedTick(5 ether, S, TS), -191160, "5 ETH FDV tick");
        assertEq(BackingMath.unbackedTick(1 ether, S, TS), -207300, "1 ETH FDV tick");
        // Each must be a multiple of the spacing.
        assertEq(BackingMath.unbackedTick(5 ether, S, TS) % TS, 0, "not spacing-aligned");
    }

    /// The pool opens at NO MORE than the target FDV (flooring is one-sided) and
    /// within one-spacing's band below — the WETH FDV back-checks the tick.
    /// forge-config: default.fuzz.runs = 5000
    function testFuzz_unbackedOpensWithinToleranceOfFdv(uint256 fdvWeth) public pure {
        fdvWeth = bound(fdvWeth, 1e16, 100_000 ether); // 0.01 .. 100k ETH FDV
        int24 tick = BackingMath.unbackedTick(fdvWeth, S, TS); // must not revert in-range
        uint256 poolP0 = _poolP0(tick); // WETH per token, 1e18
        uint256 expected = FullMath.mulDiv(fdvWeth, 1e18, S); // target WETH/token, 1e18
        assertLe(poolP0, expected + 1, "opened above target FDV");
        assertGe(poolP0, FullMath.mulDiv(expected, LOWER_BOUND_BPS, BPS), "opened >0.70% below target FDV");
        assertGt(poolP0, 0, "P0 rounded to zero");
    }

    /// Doubling the FDV moves the opening price ~2x (monotone, no cliff).
    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_unbackedFdvScalesLinearly(uint256 fdvWeth) public pure {
        fdvWeth = bound(fdvWeth, 1e16, 10_000 ether);
        int24 t1 = BackingMath.unbackedTick(fdvWeth, S, TS);
        int24 t2 = BackingMath.unbackedTick(fdvWeth * 2, S, TS);
        assertGe(t2, t1, "higher FDV must not lower opening price");
        assertApproxEqAbs(int256(t2) - int256(t1), int256(6931), 120, "2x FDV != ~2x price");
    }

    function extUnbacked(uint256 fdvWeth) external pure returns (int24) {
        return BackingMath.unbackedTick(fdvWeth, S, TS);
    }

    function test_unbackedTick_zeroFdvReverts() public {
        vm.expectRevert(BackingMath.P0OutOfRange.selector);
        this.extUnbacked(0);
    }
}
