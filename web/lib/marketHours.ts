// Two-tier, market-hours-aware freshness classification.
//
// staleAfter as a single blunt threshold collapses two very different states:
//   RESTING — expected, scheduled (Friday close through the weekend). Information.
//   STALE   — unexpected, broken (feed died while the market was open). A warning.
// They must never look the same. updatedAt (from the feed, on-chain) is the source
// of truth; this module derives the tier off-chain using the feed's market-hours
// class and US/Eastern wall-clock.
//
// us_equities_24/5: trades continuously Sunday 20:00 ET → Friday 20:00 ET; the only
// scheduled close is the weekend. (Market holidays aren't modelled precisely; the
// absolute staleAfter outer bound catches an over-long closure.)

export enum MarketHoursClass {
  Unknown = 0,
  UsEquities24_5 = 1,
  Crypto24_7 = 2,
}

export type FreshnessTier = "fresh" | "resting" | "stale";

export interface Freshness {
  tier: FreshnessTier;
  /** short chip label */
  label: string;
}

// During an open market, this is the longest gap we tolerate before calling the
// feed broken. Equity feeds update well within this.
const TRADING_STALE_SEC = 3600; // 1h

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

// ET offset (seconds) at a given instant, handling DST.
function etOffsetSec(unixSec: number): number {
  const p = etParts(unixSec);
  const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.hour, p.minute) / 1000;
  return asIfUtc - Math.floor(unixSec / 60) * 60; // compare at minute resolution
}

// Convert an ET wall-clock (with possibly out-of-range day, which Date.UTC
// normalises) to a unix timestamp.
function etWallClockToUnix(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi) / 1000; // ET wall interpreted as UTC
  return guess - etOffsetSec(guess);
}

// Open continuously Sun 20:00 ET → Fri 20:00 ET.
function isWindowOpen(weekday: number, hour: number): boolean {
  if (weekday >= 1 && weekday <= 4) return true; // Mon–Thu
  if (weekday === 5) return hour < 20; // Fri until 20:00
  if (weekday === 0) return hour >= 20; // Sun from 20:00
  return false; // Sat
}

// Most recent Friday 20:00 ET at or before `nowSec`.
function lastWindowCloseSec(nowSec: number): number {
  const p = etParts(nowSec);
  const daysSinceFri = (p.weekday - 5 + 7) % 7; // 0 if today is Friday
  let close = etWallClockToUnix(p.y, p.mo, p.d - daysSinceFri, 20, 0);
  if (close > nowSec) close -= 7 * 86400; // Friday before 20:00 → previous week
  return close;
}

/**
 * @param outerStale the on-chain `stale` flag (age exceeded the absolute
 *        per-asset staleAfter bound). Used as the outer safety net so this module
 *        doesn't need the raw staleAfter value.
 */
export function classifyFreshness(
  updatedAtSec: number,
  marketHours: number,
  outerStale: boolean,
  nowSec: number,
): Freshness {
  const age = Math.max(0, nowSec - updatedAtSec);

  if (marketHours === MarketHoursClass.Crypto24_7) {
    return age <= TRADING_STALE_SEC
      ? { tier: "fresh", label: "Live" }
      : { tier: "stale", label: `No update ${fmtAge(age)}` };
  }

  if (marketHours === MarketHoursClass.UsEquities24_5) {
    const now = etParts(nowSec);
    if (isWindowOpen(now.weekday, now.hour)) {
      // Market open → the feed should be updating. Any long gap is a fault.
      return age <= TRADING_STALE_SEC
        ? { tier: "fresh", label: "Live" }
        : { tier: "stale", label: `Market open, no update ${fmtAge(age)}` };
    }
    // Market closed. Resting is expected — but only if the feed was still fresh at
    // the last close. If it went quiet well before close, or blew past the outer
    // bound, it is stale, not resting.
    if (outerStale) return { tier: "stale", label: `No update ${fmtAge(age)}` };
    const closedFor = Math.max(0, nowSec - lastWindowCloseSec(nowSec));
    if (age > closedFor + TRADING_STALE_SEC) {
      return { tier: "stale", label: "Went quiet before close" };
    }
    return { tier: "resting", label: "Valued at last close" };
  }

  // Unknown class: fall back to the outer bound only.
  return outerStale ? { tier: "stale", label: `No update ${fmtAge(age)}` } : { tier: "fresh", label: "Recent" };
}

function fmtAge(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

/** ET wall-clock string like "Fri Jul 24, 4:00 PM ET" for the timestamp label. */
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
