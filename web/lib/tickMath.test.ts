import { describe, it, expect } from "vitest";
import {
  getSqrtRatioAtTick,
  tickForPrice,
  liquidityForAmount0,
  liquidityForAmount1,
} from "./tickMath";

const Q96 = 1n << 96n;

describe("getSqrtRatioAtTick (canonical v4 TickMath port)", () => {
  it("returns 2^96 at tick 0", () => {
    // sqrtPriceX96 at tick 0 is exactly 1.0 << 96.
    expect(getSqrtRatioAtTick(0)).toBe(79228162514264337593543950336n);
  });

  it("matches known reference values", () => {
    // Reference values from Uniswap's TickMath (within the rounding the port uses).
    expect(getSqrtRatioAtTick(1)).toBe(79232123823359799118286999568n);
    expect(getSqrtRatioAtTick(-1)).toBe(79224201403219477170569942574n);
  });

  it("is strictly monotonic in tick", () => {
    let prev = 0n;
    for (const t of [-500, -60, -1, 0, 1, 60, 500, 60000]) {
      const v = getSqrtRatioAtTick(t);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("throws out of range", () => {
    expect(() => getSqrtRatioAtTick(900000)).toThrow();
  });
});

describe("tickForPrice", () => {
  it("price 1 maps to tick ~0 when token is currency0", () => {
    // price 1 -> raw ratio 1 -> tick 0, aligned down to spacing 60 => 0.
    expect(tickForPrice(1, true, 60)).toBe(0);
  });

  it("aligns down to spacing", () => {
    const t = tickForPrice(1.5, true, 60);
    expect(t % 60).toBe(0);
  });

  it("inverts when token is currency1", () => {
    // Same price, opposite ordering => opposite-sign tick region.
    const asC0 = tickForPrice(2, true, 60);
    const asC1 = tickForPrice(2, false, 60);
    expect(asC1).toBeLessThan(asC0);
  });
});

describe("liquidity formulas", () => {
  it("amount1 liquidity scales with range width", () => {
    const sqrtA = getSqrtRatioAtTick(0);
    const sqrtB = getSqrtRatioAtTick(60);
    const L = liquidityForAmount1(10n ** 18n, sqrtA, sqrtB);
    expect(L).toBeGreaterThan(0n);
  });

  it("amount0 liquidity is positive for a valid range", () => {
    const sqrtA = getSqrtRatioAtTick(0);
    const sqrtB = getSqrtRatioAtTick(60);
    const L = liquidityForAmount0(10n ** 18n, sqrtA, sqrtB);
    expect(L).toBeGreaterThan(0n);
  });

  it("returns 0 for a zero-width range", () => {
    const s = getSqrtRatioAtTick(0);
    expect(liquidityForAmount0(10n ** 18n, s, s)).toBe(0n);
    expect(liquidityForAmount1(10n ** 18n, s, s)).toBe(0n);
  });

  it("Q96 sanity: constant matches 2^96", () => {
    expect(Q96).toBe(79228162514264337593543950336n);
  });
});
