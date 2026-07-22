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

/** Backing per token is 1e18 USD per whole token; show more precision for small values. */
export function formatBackingPerToken(value1e18: bigint): string {
  const v = Number(value1e18) / 1e18;
  if (v === 0) return "$0.00";
  const decimals = v < 0.01 ? 6 : v < 1 ? 4 : 2;
  return `$${v.toFixed(decimals)}`;
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
