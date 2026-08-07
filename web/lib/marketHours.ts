// Two-tier, market-hours-aware freshness classification.
//
// staleAfter as a single blunt threshold collapses two very different states:
//   RESTING — expected, scheduled (weekend / holiday close). Information.
//   STALE   — unexpected, broken (feed died while the market was open). A warning.
// They must never look the same, and a warning that cries wolf gets ignored — so
// STALE must not fire on days the exchange is legitimately closed. updatedAt (from
// the feed, on-chain) is the source of truth; this module derives the tier
// off-chain using the feed's market-hours class, US/Eastern wall-clock (DST via
// Intl, never a hardcoded offset), and an NYSE holiday calendar.
//
// us_equities_24/5: trades continuously Sunday 20:00 ET → Friday 20:00 ET, minus
// exchange holidays and early closes.

export enum MarketHoursClass {
  Unknown = 0,
  UsEquities24_5 = 1,
  Crypto24_7 = 2,
}

export type FreshnessTier = "fresh" | "resting" | "stale";

export interface Freshness {
  tier: FreshnessTier;
  label: string;
}

// Cosmetic split only, NOT a staleness threshold: under this age we label a feed a
// plain "Live"; above it (but still within its per-asset outer bound) it reads
// "Live · quiet". Both are the FRESH tier. Age is not a proxy for inaccuracy on a
// deviation-threshold feed — a quiet-but-recent price is correct — so a long gap is
// only ever "quiet", never stale, until the feed passes its outer bound.
const QUIET_LABEL_SEC = 3600; // 1h

// ── NYSE calendar ──────────────────────────────────────────────────────────
// Hardcoded because holidays are irregular (Good Friday, observed-date shifts).
// EXTEND THIS TABLE as years pass. The exported CALENDAR_MAX_YEAR + the
// marketHours.test.ts guard fail loudly once "now" outruns the table, rather than
// silently degrading. When exhausted the classifier falls back to RESTING (never a
// false STALE) with a "calendar out of date" note.
export const CALENDAR_MIN_YEAR = 2026;
export const CALENDAR_MAX_YEAR = 2027;

// Full-day closes (ET calendar dates).
const HOLIDAYS_FULL = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed, Jul 4 = Sat)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed, Jun 19 = Sat)
  "2027-07-05", // Independence Day (observed, Jul 4 = Sun)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas (observed, Dec 25 = Sat)
]);

// Early closes: market shuts at this ET hour (1pm) instead of running 24h.
const EARLY_CLOSES: Record<string, number> = {
  "2026-11-27": 13, // day after Thanksgiving
  "2026-12-24": 13, // Christmas Eve (a trading Thursday in 2026)
  "2027-11-26": 13, // day after Thanksgiving
  // 2027 Christmas Eve (Dec 24) is the observed Christmas holiday → full close.
};

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface EtParts {
  y: number;
  mo: number;
  d: number;
  weekday: number;
  hour: number;
  minute: number;
}

function etParts(unixSec: number): EtParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(unixSec * 1000))) p[part.type] = part.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    weekday: WEEKDAY[p.weekday ?? ""] ?? 0,
    hour,
    minute: Number(p.minute),
  };
}

function dateKey(p: EtParts): string {
  const mo = String(p.mo).padStart(2, "0");
  const d = String(p.d).padStart(2, "0");
  return `${p.y}-${mo}-${d}`;
}

export function isCalendarExhausted(unixSec: number): boolean {
  const y = etParts(unixSec).y;
  return y < CALENDAR_MIN_YEAR || y > CALENDAR_MAX_YEAR;
}

/** Is the US equities 24/5 market open at this instant (weekend + holidays + early closes)? */
export function isMarketOpenAt(unixSec: number): boolean {
  const p = etParts(unixSec);
  // Weekend gap: Fri 20:00 ET → Sun 20:00 ET.
  if (p.weekday === 6) return false; // Sat
  if (p.weekday === 0 && p.hour < 20) return false; // Sun before reopen
  if (p.weekday === 5 && p.hour >= 20) return false; // Fri after close
  const key = dateKey(p);
  if (HOLIDAYS_FULL.has(key)) return false;
  const ec = EARLY_CLOSES[key];
  if (ec !== undefined && p.hour >= ec) return false;
  return true;
}

/**
 * The next instant the US-equities 24/5 market opens at or after `nowSec`, or
 * null if that falls beyond the holiday calendar (we won't guess). Scanned at
 * 30-min resolution — matches lastCloseSec and is robust across holidays. Used by
 * the create flow to tell a creator when a market-closed backed launch can proceed,
 * rather than letting them discover a resting feed only after signing.
 */
export function nextOpenSec(nowSec: number): number | null {
  if (isMarketOpenAt(nowSec)) return nowSec;
  const STEP = 1800;
  for (let t = nowSec + STEP; t < nowSec + 14 * 86400; t += STEP) {
    if (isCalendarExhausted(t)) return null;
    if (isMarketOpenAt(t)) {
      // Walk back to the minute the window actually opens for a precise label.
      let open = t;
      while (open - 60 > nowSec && isMarketOpenAt(open - 60)) open -= 60;
      return open;
    }
  }
  return null;
}

/**
 * Classify a feed's freshness for display and for the create-flow gate.
 *
 * `beyondBound` is the per-asset outer staleness flag: age > AssetRegistry
 * .staleAfter(asset), computed on-chain (BackingLens.stale) or off-chain by the
 * caller. It — NOT a blunt trading-hours window — is what separates a correct,
 * quiet price from a genuinely dead feed. The bounds are chosen per asset to clear
 * a legitimate market closure (96h equities / 120h SGOV), so a feed within its
 * bound over a weekend is RESTING, never falsely STALE.
 */
export function classifyFreshness(
  updatedAtSec: number,
  marketHours: number,
  beyondBound: boolean,
  nowSec: number,
): Freshness {
  const age = Math.max(0, nowSec - updatedAtSec);
  const quiet = age > QUIET_LABEL_SEC;

  if (marketHours === MarketHoursClass.Crypto24_7) {
    // Crypto trades 24/7, so there's no "resting" — within bound it's live, past
    // its bound it's stale.
    if (beyondBound) return { tier: "stale", label: `No update ${fmtAge(age)}` };
    return quiet ? { tier: "fresh", label: `Live · quiet (${fmtAge(age)})` } : { tier: "fresh", label: "Live" };
  }

  if (marketHours === MarketHoursClass.UsEquities24_5) {
    // Beyond the calendar we cannot know holidays. Fail SAFE: never a false STALE.
    if (isCalendarExhausted(nowSec)) {
      return quiet
        ? { tier: "resting", label: "Market calendar unavailable — can't tell if a fresh price is due" }
        : { tier: "fresh", label: "Live" };
    }

    if (isMarketOpenAt(nowSec)) {
      // Market open. A long-but-within-bound gap is LIVE (quiet), not stale — age is
      // not inaccuracy on a deviation-threshold feed. Only past the outer bound is a
      // real fault.
      if (beyondBound) return { tier: "stale", label: `Market open, no update ${fmtAge(age)}` };
      return quiet ? { tier: "fresh", label: `Live · quiet (${fmtAge(age)})` } : { tier: "fresh", label: "Live" };
    }

    // Market closed (weekend / holiday / early close). Resting is expected unless the
    // feed is already past its outer bound — then it went quiet well before this
    // close and is genuinely stale. (Tradeoff: the bound is now-relative, so at the
    // very tail of an unusually long closure a slow feed could tip to stale; the
    // per-asset bounds are sized to clear normal closures, so in practice it doesn't.)
    if (beyondBound) return { tier: "stale", label: "Went quiet before close" };
    return { tier: "resting", label: "Valued at last close" };
  }

  // Unknown class: fall back to the on-chain outer bound only.
  return beyondBound ? { tier: "stale", label: `No update ${fmtAge(age)}` } : { tier: "fresh", label: "Recent" };
}

function fmtAge(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

/** ET wall-clock string like "Fri Jul 24, 4:00 PM ET". */
export function formatEt(unixSec: number): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${f.format(new Date(unixSec * 1000))} ET`;
}
