/**
 * Local, versioned logo files for reserve assets (AssetRegistry allowlist +
 * the quote-asset candidates). Source set: docs/assets-brand/ballast-ticker-logos/.
 *
 * Never hotlink a CDN for these — third-party trademark logos must work
 * offline and can't break when someone else's repo moves or rate-limits us.
 *
 * `scale` is the fraction of the disc diameter the mark occupies, tuned per
 * shape (a wide wordmark and a compact glyph can't share one percentage) —
 * eyeballed at 24/32/48/96px on /styleguide. Default covers the square-icon
 * majority; only the specific tickers below need an override.
 */

export type TickerLogo = {
  file: string;
  scale: number;
};

const DEFAULT_SCALE = 0.56;

const SCALE_OVERRIDES: Record<string, number> = {
  NVDA: 0.62,
  AMZN: 0.62,
  SPY: 0.66,
  QQQ: 0.66,
  MSFT: 0.5,
};

// Wordmarks (not square icons) that read busier than a glyph at small sizes —
// below this pixel size, AssetDisc falls back to the monogram instead.
export const WORDMARK_MIN_PX: Record<string, number> = {
  SPY: 32,
  QQQ: 32,
};

const FILES: Record<string, string> = {
  AAPL: "AAPL.png",
  AMZN: "AMZN.png",
  BTC: "BTC.svg",
  ETH: "ETH.svg",
  GOOGL: "GOOGL.png",
  META: "META.png",
  MSFT: "MSFT.png",
  NVDA: "NVDA.png",
  QQQ: "QQQ.png",
  SGOV: "SGOV.svg",
  SPY: "SPY.png",
  TSLA: "TSLA.png",
  USDC: "USDC.png",
  USDT: "USDT.png",
  WETH: "WETH.svg",
};

export const TICKER_LOGOS: Record<string, TickerLogo> = Object.fromEntries(
  Object.entries(FILES).map(([ticker, file]) => [
    ticker,
    { file, scale: SCALE_OVERRIDES[ticker] ?? DEFAULT_SCALE },
  ]),
);

/**
 * Resolves a real local logo for a reserve-asset ticker at a given render
 * size, or undefined if there is none (AssetDisc's monogram is the only
 * fallback, and only for the AssetDisc caller to apply).
 */
export function tickerLogoFor(symbol: string | undefined, sizePx: number): TickerLogo | undefined {
  if (!symbol) return undefined;
  const ticker = symbol.toUpperCase();
  const logo = TICKER_LOGOS[ticker];
  if (!logo) return undefined;
  const minPx = WORDMARK_MIN_PX[ticker];
  if (minPx !== undefined && sizePx < minPx) return undefined;
  return logo;
}
