import { describe, it, expect } from "vitest";
import { exactInSingleTick } from "./elysiumQuote";

const Q96 = 1n << 96n;

describe("exactInSingleTick (v4 single-tick exact-in math)", () => {
  // At price 1 (sqrtP = Q96) with deep liquidity, a small exact-in trade returns
  // ~the same amount out (minus the slice of price impact).
  const sqrtP = Q96;
  const L = 10n ** 24n; // deep

  it("gives positive, near-parity output at price 1 for a small trade (zeroForOne)", () => {
    const amountIn = 10n ** 18n; // 1 unit
    const out = exactInSingleTick(sqrtP, L, amountIn, true);
    expect(out).toBeGreaterThan(0n);
    // out should be slightly less than amountIn (price impact) but same order.
    expect(out).toBeLessThanOrEqual(amountIn);
    expect(out * 100n).toBeGreaterThan(amountIn * 99n); // within ~1% for a tiny trade
  });

  it("gives positive output for !zeroForOne too", () => {
    const amountIn = 10n ** 18n;
    const out = exactInSingleTick(sqrtP, L, amountIn, false);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThanOrEqual(amountIn);
  });

  it("returns 0 with no liquidity or no input", () => {
    expect(exactInSingleTick(sqrtP, 0n, 10n ** 18n, true)).toBe(0n);
    expect(exactInSingleTick(sqrtP, L, 0n, true)).toBe(0n);
    expect(exactInSingleTick(0n, L, 10n ** 18n, true)).toBe(0n);
  });

  it("larger input yields more output but with worse rate (price impact)", () => {
    const small = exactInSingleTick(sqrtP, L, 10n ** 18n, true);
    const big = exactInSingleTick(sqrtP, L, 100n * 10n ** 18n, true);
    expect(big).toBeGreaterThan(small);
    // rate (out/in) must degrade with size
    const smallRate = (small * 10n ** 18n) / 10n ** 18n;
    const bigRate = (big * 10n ** 18n) / (100n * 10n ** 18n);
    expect(bigRate).toBeLessThanOrEqual(smallRate);
  });
});
