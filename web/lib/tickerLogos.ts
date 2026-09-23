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

// Wide wordmarks (SPY's SPDR eagle+text, QQQ's Invesco wordmark, AVGO's
// pulse-in-circle mark, CRCL's "CRCL" wordmark) sit small within their own
// padded canvas, so they need a LARGER inset than a square icon to read at
// the same visual weight — not a smaller one. AAPL/MSFT are dense square
// icons and run smaller so they don't overpower their disc.
const SCALE_OVERRIDES: Record<string, number> = {
  NVDA: 0.62,
  AMZN: 0.62,
  SPY: 0.66,
  QQQ: 0.66,
  AVGO: 0.64,
  CRCL: 0.64,
  AAPL: 0.5,
  MSFT: 0.5,
};

// Wordmarks (not square icons) that read busier than a glyph at small sizes —
// below this pixel size, AssetDisc falls back to the monogram instead.
export const WORDMARK_MIN_PX: Record<string, number> = {
  SPY: 32,
  QQQ: 32,
  CRCL: 32,
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
  // Batch 2 — treasury-allowlist candidates, not (yet) quote-asset GREEN.
  AMD: "AMD.png",
  AVGO: "AVGO.png",
  MSTR: "MSTR.png",
  PLTR: "PLTR.png",
  COIN: "COIN.png",
  HOOD: "HOOD.png",
  NFLX: "NFLX.png",
  ORCL: "ORCL.png",
  CRCL: "CRCL.png",
  MCD: "MCD.png",
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
