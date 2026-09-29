import { describe, expect, it } from "vitest";
import { sanitizeCandles, shouldResetSeries } from "./market";
import type { Candle } from "./market";

const c = (t: number, close = 1): Candle => ({ t, o: close, h: close, l: close, c: close, v: 1 });

describe("sanitizeCandles", () => {
  it("sorts unsorted candles ascending by time", () => {
    const out = sanitizeCandles([c(300), c(100), c(200)]);
    expect(out.map((x) => x.t)).toEqual([100, 200, 300]);
  });

  it("drops duplicate timestamps, keeping the last occurrence", () => {
    const out = sanitizeCandles([c(100, 1), c(100, 2), c(200, 3)]);
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.t === 100)?.c).toBe(2);
  });

  it("drops rows with non-finite fields (NaN/Infinity)", () => {
    const bad: Candle = { t: 100, o: NaN, h: 1, l: 1, c: 1, v: 1 };
    const out = sanitizeCandles([bad, c(200)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.t).toBe(200);
  });

  it("returns [] for empty input, never throws", () => {
    expect(sanitizeCandles([])).toEqual([]);
  });

  it("handles the exact 'All' timeframe crash shape: reversed + repeated GT day rows", () => {
    // Mirrors fetchPoolOhlcv's real observed shape for a low-volume pool: GT's
    // day-granularity endpoint repeating the same bucket after the .reverse().
    const raw = [c(500), c(400), c(400), c(300), c(300), c(300), c(200)];
    const out = sanitizeCandles(raw);
    const times = out.map((x) => x.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });
});

describe("shouldResetSeries — the 'All' timeframe crash", () => {
  it("resets on a structural change (timeframe/kind/unit) regardless of time", () => {
    expect(shouldResetSeries(true, 1_700_000_000, 1_600_000_000)).toBe(true);
  });

  it("does NOT reset for a normal forward-moving live tick", () => {
    expect(shouldResetSeries(false, 1_700_000_000, 1_700_000_060)).toBe(false);
  });

  it("does NOT reset for a same-bar price update (equal time)", () => {
    expect(shouldResetSeries(false, 1_700_000_000, 1_700_000_000)).toBe(false);
  });

  it("has nothing to compare against on first paint — never forces a reset by itself", () => {
    expect(shouldResetSeries(false, null, 1_700_000_000)).toBe(false);
  });

  // The actual bug: react-query's placeholderData shows the PREVIOUS (finer-grained)
  // timeframe's series under the NEW resetKey while coarser real data is in flight.
  // When "All" (day buckets, rounded down to UTC midnight) then lands, its last
  // timestamp is earlier than the placeholder's near-now timestamp — series.update()
  // would throw. Must force a full setData() instead.
  it("resets when the incoming time is BEHIND the previous tick under the same resetKey", () => {
    const placeholderLastTick = 1_790_640_050; // e.g. 1W's last hourly candle, near-now
    const realAllData = 1_790_640_000; // "All"'s day-bucketed candle, rounded to UTC midnight
    expect(shouldResetSeries(false, placeholderLastTick, realAllData)).toBe(true);
  });
});
