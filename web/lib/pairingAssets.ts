// Pure, chain-independent display data for BALLAST's pool-pairing candidates —
// WETH plus every stock/RWA ticker on the AssetRegistry allowlist track (see
// docs/exit-liquidity-table.md). Marketing pages (landing, docs) carry NO
// wallet provider and must never import wagmi (CLAUDE.md: wallet providers
// wrap only /app) — so this is a hand-maintained mirror for DECORATIVE
// display only (the landing marquee, the marketing/Discover "pairs" strip).
//
// This is never the source of truth for what a launch can actually select —
// inside /app, useQuoteAssets() reads isGreenQuoteAsset() live on-chain per
// address, and that result always wins over anything hardcoded here.
//
// GREEN mirrors the current on-chain quote-asset allowlist (SGOV, NVDA, SPY —
// docs/exit-liquidity-table.md "Recommendation for A1's final step"). Router
// path mirrors BallastRouter's wired routes (NVDA, SPY — same doc, "Batch-2
// router compatibility": the router's leg 1 is single-hop-only, so only a
// direct WETH pool counts, not the deeper via-USDG routes that drive the
// GREEN/AMBER/RED classification). Update both sets if either changes.
export type PairingTicker = {
  key: string;
  symbol: string;
  isWeth?: boolean;
  isGreen: boolean;
  hasEthRoute?: boolean;
};

export const GREEN_TICKERS = new Set(["SGOV", "NVDA", "SPY"]);
export const ETH_ROUTE_TICKERS = new Set(["NVDA", "SPY"]);

// The 16 stock/RWA tickers reviewed in docs/exit-liquidity-table.md (batch 1
// + batch 2), in that doc's order. Not every one is on-chain-allowlisted yet
// (only ~35 of ~95 tokenized stocks have a Chainlink feed at all — CLAUDE.md
// oracle rule 17) — this list is the full candidate set for "coming soon"
// display purposes, not a claim that all 16 are live.
const STOCK_TICKERS = [
  "SGOV",
  "NVDA",
  "SPY",
  "META",
  "QQQ",
  "AAPL",
  "GOOGL",
  "TSLA",
  "MSFT",
  "AMZN",
  "AMD",
  "COIN",
  "PLTR",
  "ORCL",
  "MSTR",
  "CRCL",
];

export const PAIRING_TICKERS: PairingTicker[] = [
  { key: "WETH", symbol: "WETH", isWeth: true, isGreen: true, hasEthRoute: true },
  ...STOCK_TICKERS.map((symbol) => ({
    key: symbol,
    symbol,
    isGreen: GREEN_TICKERS.has(symbol),
    hasEthRoute: ETH_ROUTE_TICKERS.has(symbol),
  })),
];
