import { describe, it, expect } from "vitest";
import { computeMinOut } from "./swap";

// Guards BallastRouterV2.sol:1 rule 1 — every buy/sell must send a real minOut
// computed from the live quote and the user's slippage, never 0 or 1 (short of a
// genuinely absent quote, which the caller treats as "not ready to swap").
describe("computeMinOut", () => {
  it("never goes below quote minus slippage, for a wide range of quotes/slippages", () => {
    const quotes = [1n, 2n, 999n, 1_000n, 1_234_567n, 10n ** 18n, 10n ** 24n];
    const slippages = [1, 10, 50, 100, 250, 500, 1000, 1499, 2500, 5000, 9999];
    for (const quote of quotes) {
      for (const bps of slippages) {
        const minOut = computeMinOut(quote, bps);
        const floorAllowed = (quote * BigInt(10000 - bps)) / 10000n;
        expect(minOut).toBeGreaterThanOrEqual(floorAllowed);
        // and never more than a rounding unit above it either — this is the exact
        // accept-at-least figure, not a looser (easier-to-satisfy) one.
        expect(minOut).toBeLessThanOrEqual(floorAllowed + 1n);
      }
    }
  });

  it("matches the exact 1% example a user would see", () => {
    expect(computeMinOut(1_000_000n, 100)).toBe(990_000n);
  });

  it("is never 0 or 1 for a real quote at a sane slippage", () => {
    expect(computeMinOut(10n ** 18n, 50)).toBeGreaterThan(1n);
    expect(computeMinOut(1_000n, 500)).toBeGreaterThan(1n);
  });

  it("floors to 0 only when there is no quote yet — never silently accepts any output", () => {
    expect(computeMinOut(undefined, 100)).toBe(0n);
    expect(computeMinOut(0n, 100)).toBe(0n);
  });

  it("floors to 0 at/above 100% slippage instead of underflowing", () => {
    expect(computeMinOut(1_000n, 10000)).toBe(0n);
    expect(computeMinOut(1_000n, 15000)).toBe(0n);
  });

  it("clamps a negative slippage to 0bps rather than inflating minOut past the quote", () => {
    expect(computeMinOut(1_000n, -5)).toBe(1_000n);
  });
});
