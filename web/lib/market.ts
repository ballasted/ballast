// External market data from GeckoTerminal (Part E). GeckoTerminal indexes
// Robinhood Chain under the network slug "robinhood" and surfaces its Uniswap-v4
// pools, with a free, key-less API. We use it ONLY for market colour — price,
// 24h volume/change, and the list of venues — never for backing valuation, which
// stays on-chain via BackingLens (CLAUDE.md). Every figure sourced here is
// labelled with its origin + fetch time, and where a chain price exists the chain
// wins (see MarketPanel).
export const GT_NETWORK = "robinhood";

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
