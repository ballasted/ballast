// Display helpers. All BackingLens USD values are 1e18 fixed point.

const WAD = 10n ** 18n;

/** Format a 1e18-scaled USD value as a dollar string. */
export function formatUsd(value1e18: bigint, opts?: { compact?: boolean }): string {
  const dollars = Number(value1e18) / 1e18;
  if (opts?.compact && dollars >= 1000) {
    return `$${Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(dollars)}`;
  }
  return `$${Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(dollars)}`;
}

/** The one small-dollar-value formatter for anything that can be a fraction of a
 *  cent per unit (token price, backing per token, anything "$ per token"). A
 *  fixed decimal count reads a genuinely tiny value (e.g. backing/token in the
 *  1e-7 range on a 1e9-supply launch) as a flat "$0.00" — the exact bug this
 *  exists to prevent. `toPrecision(3)` naturally switches to exponential
 *  notation ("$5.16e-7") once the value is small enough that 3 significant
 *  figures wouldn't otherwise fit in fixed notation, so a real value is never
 *  silently indistinguishable from zero.
 */
export function formatSmallUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1) return `${sign}$${abs.toLocaleString("en", { maximumFractionDigits: 2 })}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toPrecision(3)}`; // e.g. $0.00000500 / $5.16e-7
}

/** Backing per token is 1e18 USD per whole token — same small-dollar-value
 *  formatter as price (formatSmallUsd), so the two figures on a card never
 *  disagree about how to represent a fractional-cent amount. */
export function formatBackingPerToken(value1e18: bigint): string {
  return formatSmallUsd(Number(value1e18) / 1e18);
}

/** market price ÷ backing per token, both 1e18. Returns null if backing is 0. */
export function backingRatio(marketPrice1e18: bigint, backingPerToken1e18: bigint): number | null {
  if (backingPerToken1e18 === 0n) return null;
  return Number((marketPrice1e18 * WAD) / backingPerToken1e18) / 1e18;
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** "3d 4h", "2h 10m", "5m" from seconds. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3 minutes ago" style, coarse. */
export function timeAgo(unixSeconds: number, nowSeconds: number): string {
  const s = Math.max(0, nowSeconds - unixSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
