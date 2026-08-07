// External market data from GeckoTerminal (Part E). GeckoTerminal indexes
// Robinhood Chain under the network slug "robinhood" and surfaces its Uniswap-v4
// pools, with a free, key-less API. We use it ONLY for market colour — price,
// 24h volume/change, and the list of venues — never for backing valuation, which
// stays on-chain via BackingLens (CLAUDE.md). Every figure sourced here is
// labelled with its origin + fetch time, and where a chain price exists the chain
// wins (see MarketPanel).
export const GT_NETWORK = "robinhood";

// ── Market cap, computed ONE way everywhere (spec 1.4) ────────────────────────
// A token's market cap must be identical on Discover, the featured strip, its token
// page, and a portfolio row. The only thing that ever differed between those places
// was the SUPPLY leg (BackingLens.totalSupply vs token.totalSupply() vs the launch
// constant, in different precedence). These two helpers fix the supply policy and
// the arithmetic in one place so the figure can't drift.
import { TOTAL_SUPPLY } from "@/lib/contracts";

/** Canonical supply for market-cap math. BackingLens.totalSupply and token
 *  totalSupply() are the same ERC-20 total; prefer backing, then the token read,
 *  then the fixed launch supply. `> 0n` guards a zero/partial read. */
export function marketCapSupply(backingSupply?: bigint, tokenSupply?: bigint): bigint {
  if (backingSupply !== undefined && backingSupply > 0n) return backingSupply;
  if (tokenSupply !== undefined && tokenSupply > 0n) return tokenSupply;
  return TOTAL_SUPPLY;
}

/** Market cap = price (USD, 1e18) × supply, 1e18-scaled. Undefined when no price. */
export function marketCapUsd(priceUsd1e18: bigint | undefined, supply: bigint): bigint | undefined {
  if (priceUsd1e18 === undefined) return undefined;
  return (priceUsd1e18 * supply) / 10n ** 18n;
}

export type MarketPool = {
  address: string;
  name: string;
  dexId: string;
  volume24hUsd: number;
  reserveUsd: number;
  change24hPct: number | null;
};

export type MarketData = {
  available: boolean;
  source: "GeckoTerminal";
  reason?: "not-indexed" | "unreachable" | "no-token";
  fetchedAt?: number; // unix seconds, when our server fetched it
  priceUsd?: number;
  volume24hUsd?: number;
  change24hPct?: number | null;
  pools: MarketPool[];
  top?: MarketPool;
};

// ── Recent trades (GeckoTerminal per-pool trades endpoint) ───────────────────
// Direction is derived from the token addresses, not GeckoTerminal's pool-relative
// `kind`, so "buy" always means someone bought THIS launch token regardless of how
// the pool's base/quote happen to be assigned.
export type Trade = {
  kind: "buy" | "sell";
  ts: number; // unix seconds
  txHash: string;
  wallet: string;
  tokenAmount: number; // amount of the launch token
  volumeUsd: number;
  priceUsd: number; // price of the launch token in USD at the trade
};

export type TradesData = {
  available: boolean;
  source: "GeckoTerminal";
  reason?: "no-token" | "not-indexed" | "unreachable";
  fetchedAt?: number;
  pool?: string;
  trades: Trade[];
};

// ── Trending (aggregated from 24h trades across launches) ────────────────────
export type TrendingItem = {
  token: string;
  uniqueBuyers: number;
  volume24hUsd: number;
  trades24h: number;
};

export type TrendingData = {
  available: boolean;
  source: "GeckoTerminal";
  fetchedAt?: number;
  // Thin = too little 24h activity to rank meaningfully. The UI says so rather than
  // presenting a near-random order as a ranking.
  thin: boolean;
  // Some launches were not scored (rate/cap guard) — surfaced, never silently dropped.
  capped?: number;
  items: TrendingItem[]; // ranked: unique buyers desc, then 24h volume desc
};

// ── OHLCV candles (GeckoTerminal per-pool OHLCV endpoint) ────────────────────
// The terminal chart draws candlesticks from GeckoTerminal, the same source as
// trades/volume. Our six timeframes map onto GT's {minute,hour,day} + an aggregate
// count. Every candle is market colour (price discovery), never backing valuation.
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export const TIMEFRAMES: { key: Timeframe; label: string; gt: "minute" | "hour" | "day"; aggregate: number }[] = [
  { key: "1m", label: "1m", gt: "minute", aggregate: 1 },
  { key: "5m", label: "5m", gt: "minute", aggregate: 5 },
  { key: "15m", label: "15m", gt: "minute", aggregate: 15 },
  { key: "1h", label: "1h", gt: "hour", aggregate: 1 },
  { key: "4h", label: "4h", gt: "hour", aggregate: 4 },
  { key: "1d", label: "1d", gt: "day", aggregate: 1 },
];

export const DEFAULT_TIMEFRAME: Timeframe = "5m";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type OhlcvData = {
  available: boolean;
  source: "GeckoTerminal";
  reason?: "no-token" | "not-indexed" | "unreachable";
  fetchedAt?: number; // unix seconds, when our server fetched it
  pool?: string;
  timeframe: Timeframe;
  candles: Candle[]; // chronological (oldest first)
};

export function geckoPoolUrl(pool: string): string {
  return `https://www.geckoterminal.com/${GT_NETWORK}/pools/${pool}`;
}

// Dark, chrome-light embeddable chart for a pool — this is the "price chart on the
// token page instead of building our own" (Part E).
export function geckoEmbedUrl(pool: string): string {
  return `https://www.geckoterminal.com/${GT_NETWORK}/pools/${pool}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`;
}

export function dexscreenerUrl(pool: string): string {
  return `https://dexscreener.com/${GT_NETWORK}/${pool}`;
}

// Human label for a GeckoTerminal dex id (e.g. "uniswap_v4" → "Uniswap v4").
export function dexLabel(dexId: string): string {
  return dexId
    .split(/[_-]/)
    .map((w) => (/^v\d$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// Plain-number USD (external prices are JS numbers, often tiny, e.g. $0.000005).
export function formatSmallUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (n >= 1) return `$${n.toLocaleString("en", { maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`; // e.g. $0.00000500
}

export function formatCompactUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Intl.NumberFormat("en", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);
}
