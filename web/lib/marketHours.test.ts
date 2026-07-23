import { describe, it, expect } from "vitest";
import {
  classifyFreshness,
  isMarketOpenAt,
  isCalendarExhausted,
  MarketHoursClass,
  CALENDAR_MAX_YEAR,
} from "./marketHours";

// Build a unix timestamp (seconds) for a US/Eastern wall-clock. `edt` selects the
// offset explicitly (EDT = UTC-4, EST = UTC-5) so these fixtures independently
// verify the module's Intl-based DST handling — if the module used a wrong offset,
// these would disagree and fail.
function et(y: number, mo: number, d: number, h: number, mi: number, edt: boolean): number {
  const offset = edt ? 4 : 5;
  return Math.floor(Date.UTC(y, mo - 1, d, h + offset, mi) / 1000);
}

const EQ = MarketHoursClass.UsEquities24_5;
const HOUR = 3600;

describe("isMarketOpenAt — sessions, weekends, holidays", () => {
  it("open on a normal weekday afternoon (EDT)", () => {
    expect(isMarketOpenAt(et(2026, 3, 16, 14, 0, true))).toBe(true); // Mon
  });
  it("open overnight on a weekday (24/5)", () => {
    expect(isMarketOpenAt(et(2026, 3, 17, 3, 0, true))).toBe(true); // Tue 3am
  });
  it("closed Saturday", () => {
    expect(isMarketOpenAt(et(2026, 3, 14, 12, 0, true))).toBe(false);
  });
  it("closed Sunday before 20:00, open after", () => {
    expect(isMarketOpenAt(et(2026, 3, 15, 19, 30, true))).toBe(false);
    expect(isMarketOpenAt(et(2026, 3, 15, 20, 30, true))).toBe(true);
  });
  it("closed Friday after 20:00", () => {
    expect(isMarketOpenAt(et(2026, 3, 13, 20, 30, true))).toBe(false);
    expect(isMarketOpenAt(et(2026, 3, 13, 19, 30, true))).toBe(true);
  });
  it("closed all day on Thanksgiving (EST)", () => {
    expect(isMarketOpenAt(et(2026, 11, 26, 12, 0, false))).toBe(false);
  });
  it("closed all day on Christmas (EST)", () => {
    expect(isMarketOpenAt(et(2026, 12, 25, 12, 0, false))).toBe(false);
  });
  it("early close: open before 1pm, closed after, on Christmas Eve 2026", () => {
    expect(isMarketOpenAt(et(2026, 12, 24, 11, 0, false))).toBe(true);
    expect(isMarketOpenAt(et(2026, 12, 24, 14, 0, false))).toBe(false);
  });
  it("early close: day after Thanksgiving 2026 closed after 1pm", () => {
    expect(isMarketOpenAt(et(2026, 11, 27, 14, 0, false))).toBe(false);
  });
});

describe("classifyFreshness — the core RESTING vs STALE distinction", () => {
  it("feed dies Monday mid-session → STALE within the hour", () => {
    const now = et(2026, 3, 16, 11, 0, true); // Mon 11:00 EDT, open
    const updated = et(2026, 3, 16, 9, 30, true); // 90m earlier
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("stale");
  });

  it("fresh during session when updated within the hour", () => {
    const now = et(2026, 3, 16, 11, 0, true);
    const updated = et(2026, 3, 16, 10, 30, true); // 30m
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("fresh");
  });

  it("Friday 8pm close, read Saturday → RESTING", () => {
    const updated = et(2026, 3, 13, 19, 55, true); // just before Fri close
    const now = et(2026, 3, 14, 12, 0, true); // Sat noon
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("resting");
  });

  it("feed went quiet Thursday, read Saturday → STALE (died before close)", () => {
    const updated = et(2026, 3, 12, 14, 0, true); // Thu afternoon
    const now = et(2026, 3, 14, 12, 0, true); // Sat noon
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("stale");
  });

  it("Sunday reopen boundary: resting just before, fresh just after (with a fresh update)", () => {
    const preReopen = et(2026, 3, 15, 19, 30, true);
    const restingUpdate = et(2026, 3, 13, 19, 55, true); // Fri close
    expect(classifyFreshness(restingUpdate, EQ, false, preReopen).tier).toBe("resting");

    const postReopen = et(2026, 3, 15, 20, 30, true);
    const freshUpdate = et(2026, 3, 15, 20, 15, true); // feed updated at reopen
    expect(classifyFreshness(freshUpdate, EQ, false, postReopen).tier).toBe("fresh");
  });
});

describe("classifyFreshness — holidays must not false-alarm", () => {
  it("Thanksgiving midday → RESTING, not STALE", () => {
    const updated = et(2026, 11, 25, 23, 55, false); // Wed just before the holiday
    const now = et(2026, 11, 26, 12, 0, false); // Thanksgiving Thu
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("resting");
  });

  it("Christmas midday → RESTING, not STALE", () => {
    const updated = et(2026, 12, 24, 12, 55, false); // Christmas Eve before early close
    const now = et(2026, 12, 25, 12, 0, false); // Christmas Fri
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("resting");
  });

  it("Christmas Eve after 1pm early close → RESTING when updated before close", () => {
    const updated = et(2026, 12, 24, 12, 55, false);
    const now = et(2026, 12, 24, 15, 0, false);
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("resting");
  });

  it("Christmas Eve early close: died before close → STALE", () => {
    const updated = et(2026, 12, 24, 9, 0, false); // quiet since morning
    const now = et(2026, 12, 24, 15, 0, false); // after 1pm close
    expect(classifyFreshness(updated, EQ, false, now).tier).toBe("stale");
  });
});

describe("classifyFreshness — DST transitions, both directions", () => {
  it("spring-forward weekend (Mar 7-8 2026): Saturday RESTING; Sunday reopen FRESH", () => {
    // Sat Mar 7 is EST; Fri Mar 6 close is EST.
    const satNow = et(2026, 3, 7, 12, 0, false);
    const friClose = et(2026, 3, 6, 19, 55, false);
    expect(classifyFreshness(friClose, EQ, false, satNow).tier).toBe("resting");
    // Sun Mar 8 20:30 is EDT (clocks sprang forward at 2am).
    const sunOpen = et(2026, 3, 8, 20, 30, true);
    const freshUpdate = et(2026, 3, 8, 20, 15, true);
    expect(classifyFreshness(freshUpdate, EQ, false, sunOpen).tier).toBe("fresh");
  });

  it("fall-back weekend (Oct 31 - Nov 1 2026): Saturday RESTING; Sunday reopen FRESH", () => {
    const satNow = et(2026, 10, 31, 12, 0, true); // EDT
    const friClose = et(2026, 10, 30, 19, 55, true); // EDT
    expect(classifyFreshness(friClose, EQ, false, satNow).tier).toBe("resting");
    // Sun Nov 1 20:30 is EST (clocks fell back at 2am).
    const sunOpen = et(2026, 11, 1, 20, 30, false);
    const freshUpdate = et(2026, 11, 1, 20, 15, false);
    expect(classifyFreshness(freshUpdate, EQ, false, sunOpen).tier).toBe("fresh");
  });
});

describe("crypto 24/7", () => {
  it("fresh within the hour, stale beyond", () => {
    const now = et(2026, 3, 14, 12, 0, true); // even a Saturday
    expect(classifyFreshness(now - 30 * 60, MarketHoursClass.Crypto24_7, false, now).tier).toBe("fresh");
    expect(classifyFreshness(now - 3 * HOUR, MarketHoursClass.Crypto24_7, false, now).tier).toBe("stale");
  });
});

describe("calendar exhaustion — fail safe, and a guard that fails when the table runs out", () => {
  it("beyond the calendar: never a false STALE; RESTING with a note", () => {
    const now = et(2028, 6, 15, 14, 0, true); // 2028 > table
    expect(isCalendarExhausted(now)).toBe(true);
    const res = classifyFreshness(now - 3 * HOUR, EQ, true, now);
    expect(res.tier).toBe("resting");
    expect(res.label.toLowerCase()).toContain("out of date");
  });

  it("still fresh beyond the calendar if recently updated", () => {
    const now = et(2028, 6, 15, 14, 0, true);
    expect(classifyFreshness(now - 30 * 60, EQ, true, now).tier).toBe("fresh");
  });

  // GUARD: fails once real time passes the hardcoded table, forcing an extension
  // rather than letting the classifier silently degrade to the exhausted fallback.
  it("holiday table still covers the current year", () => {
    expect(CALENDAR_MAX_YEAR).toBeGreaterThanOrEqual(new Date().getUTCFullYear());
  });
});
