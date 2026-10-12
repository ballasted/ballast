import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { evenSplit, snapWeight, sumWeights, BASKET_BPS } from "./basketWeights";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;

describe("evenSplit", () => {
  it("sums to exactly BASKET_BPS for 1-6 assets", () => {
    for (let n = 1; n <= 6; n++) {
      const addrs = Array.from({ length: n }, (_, i) => `0x${(i + 1).toString().padStart(40, "0")}` as Address);
      const split = evenSplit(addrs);
      expect(sumWeights(split)).toBe(BASKET_BPS);
    }
  });

  it("splits 3 ways as 3300/3300/3400, remainder on the last", () => {
    const split = evenSplit([A, B, C]);
    expect(split[A]).toBe(3300);
    expect(split[B]).toBe(3300);
    expect(split[C]).toBe(3400);
  });

  it("every weight is a whole 1% (100bps) step", () => {
    const split = evenSplit([A, B, C]);
    for (const v of Object.values(split)) expect(v % 100).toBe(0);
  });

  it("empty input returns an empty split", () => {
    expect(evenSplit([])).toEqual({});
  });
});

describe("snapWeight", () => {
  it("always sums to exactly BASKET_BPS regardless of the requested pct", () => {
    for (const pct of [0, 1, 17, 33, 50, 67, 99, 100, -5, 150]) {
      const split = snapWeight([A, B, C], A, pct);
      expect(sumWeights(split)).toBe(BASKET_BPS);
    }
  });

  it("clamps out-of-range pct into [0, 100]", () => {
    expect(snapWeight([A, B], A, -50)[A]).toBe(0);
    expect(snapWeight([A, B], A, 500)[A]).toBe(BASKET_BPS);
  });

  it("snaps to whole 1% steps", () => {
    const split = snapWeight([A, B, C], A, 37);
    expect(split[A]! % 100).toBe(0);
  });

  it("a single selected asset always takes the full 10000bps", () => {
    expect(snapWeight([A], A, 10)).toEqual({ [A]: BASKET_BPS });
  });

  it("never produces a negative weight for any other leg", () => {
    const split = snapWeight([A, B, C], A, 100);
    expect(split[B]).toBeGreaterThanOrEqual(0);
    expect(split[C]).toBeGreaterThanOrEqual(0);
  });
});
