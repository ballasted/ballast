import "server-only";
import { query } from "./db";

// Typed read helpers the pages consume through thin API routes. EVERY function
// returns null when the indexer is unconfigured, errors, or has no data for the
// request, so the caller transparently falls back to its current data source
// (chain reads / GeckoTerminal / Blockscout). None of these ever throw.

export type OhlcBucket = "1m" | "5m" | "1h" | "4h" | "1D";

export type Candle = {
  ts: number; // unix seconds (bucket start)
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

export type Trade = {
  side: "buy" | "sell";
  amountToken: number;
  amountQuote: number;
  price: number | null;
  usdSize: number | null;
  trader: string;
  ts: number; // unix seconds
  txHash: string;
};

export type Holder = { holder: string; balance: number };

export type DiscoverStats = {
  launchesTotal: number;
  tradesTotal: number;
  volumeUsdAll: number;
  volume24hUsd: number;
  trades24h: number;
};

export type AnalyticsDay = {
  day: string; // YYYY-MM-DD
  volumeUsd: number;
  trades: number;
  launches: number;
  burnedTokens: number;
};

const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** True if the indexer has indexed anything (optionally for a specific token).
 *  null = unconfigured/error → caller falls back. */
export async function indexerHasData(token?: string): Promise<boolean | null> {
  try {
    if (token) {
      const rows = await query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM swaps WHERE token = $1) AS exists`,
        [token.toLowerCase()],
      );
      if (rows === null) return null;
      return Boolean(rows[0]?.exists);
    }
    const rows = await query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM launches) AS exists`);
    if (rows === null) return null;
    return Boolean(rows[0]?.exists);
  } catch {
    return null;
  }
}

export async function getTokenOhlc(token: string, bucket: OhlcBucket, limit = 1000): Promise<Candle[] | null> {
  try {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 5000);
    const rows = await query<{ ts: string; open: string; high: string; low: string; close: string; volume_usd: string }>(
      `SELECT extract(epoch FROM ts) AS ts, open, high, low, close, volume_usd
       FROM ohlc WHERE token = $1 AND bucket = $2
       ORDER BY ts DESC LIMIT $3`,
      [token.toLowerCase(), bucket, safeLimit],
    );
    if (rows === null || rows.length === 0) return null;
    return rows
      .map((r) => ({
        ts: Math.floor(num(r.ts)),
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        close: num(r.close),
        volumeUsd: num(r.volume_usd),
      }))
      .reverse(); // ascending for charting
  } catch {
    return null;
  }
}

export async function getRecentTrades(token: string, limit = 50): Promise<Trade[] | null> {
  try {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const rows = await query<{
      side: "buy" | "sell";
      amount_token: string;
      amount_quote: string;
      price: string | null;
      usd_size: string | null;
      trader: string;
      ts: string;
      tx_hash: string;
    }>(
      `SELECT side, amount_token, amount_quote, price, usd_size, trader,
         extract(epoch FROM block_ts) AS ts, tx_hash
       FROM swaps WHERE token = $1
       ORDER BY block_number DESC, log_index DESC LIMIT $2`,
      [token.toLowerCase(), safeLimit],
    );
    if (rows === null || rows.length === 0) return null;
    return rows.map((r) => ({
      side: r.side,
      amountToken: num(r.amount_token),
      amountQuote: num(r.amount_quote),
      price: r.price === null ? null : num(r.price),
      usdSize: r.usd_size === null ? null : num(r.usd_size),
      trader: r.trader,
      ts: Math.floor(num(r.ts)),
      txHash: r.tx_hash,
    }));
  } catch {
    return null;
  }
}

export async function getTokenHolders(
  token: string,
  limit = 100,
): Promise<{ holders: Holder[]; count: number } | null> {
  try {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000);
    const rows = await query<{ holder: string; balance: string }>(
      `SELECT holder, balance FROM balances
       WHERE token = $1 AND balance > 0 AND holder NOT IN ($2, $3)
       ORDER BY balance DESC LIMIT $4`,
      [token.toLowerCase(), DEAD, ZERO, safeLimit],
    );
    if (rows === null) return null;
    const countRows = await query<{ count: string }>(
      `SELECT count(*) AS count FROM balances
       WHERE token = $1 AND balance > 0 AND holder NOT IN ($2, $3)`,
      [token.toLowerCase(), DEAD, ZERO],
    );
    const count = countRows && countRows[0] ? Math.floor(num(countRows[0].count)) : rows.length;
    if (rows.length === 0 && count === 0) return null;
    return { holders: rows.map((r) => ({ holder: r.holder, balance: num(r.balance) })), count };
  } catch {
    return null;
  }
}

export async function getDiscoverStats(): Promise<DiscoverStats | null> {
  try {
    const rows = await query<{
      launches_total: string;
      trades_total: string;
      volume_all: string;
      volume_24h: string;
      trades_24h: string;
    }>(
      `SELECT
         (SELECT count(*) FROM launches) AS launches_total,
         (SELECT count(*) FROM swaps) AS trades_total,
         (SELECT coalesce(sum(usd_size), 0) FROM swaps) AS volume_all,
         (SELECT coalesce(sum(usd_size), 0) FROM swaps WHERE block_ts > now() - interval '24 hours') AS volume_24h,
         (SELECT count(*) FROM swaps WHERE block_ts > now() - interval '24 hours') AS trades_24h`,
    );
    if (rows === null || !rows[0]) return null;
    const r = rows[0];
    return {
      launchesTotal: Math.floor(num(r.launches_total)),
      tradesTotal: Math.floor(num(r.trades_total)),
      volumeUsdAll: num(r.volume_all),
      volume24hUsd: num(r.volume_24h),
      trades24h: Math.floor(num(r.trades_24h)),
    };
  } catch {
    return null;
  }
}

export async function getAnalyticsSeries(days = 30): Promise<AnalyticsDay[] | null> {
  try {
    const safeDays = Math.min(Math.max(1, Math.floor(days)), 365);
    const rows = await query<{
      day: string;
      volume_usd: string;
      trades: string;
      launches: string;
      burned_tokens: string;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, volume_usd, trades, launches, burned_tokens
       FROM daily_rollups
       WHERE day >= (now() - make_interval(days => $1))::date
       ORDER BY day ASC`,
      [safeDays],
    );
    if (rows === null || rows.length === 0) return null;
    return rows.map((r) => ({
      day: r.day,
      volumeUsd: num(r.volume_usd),
      trades: Math.floor(num(r.trades)),
      launches: Math.floor(num(r.launches)),
      burnedTokens: num(r.burned_tokens),
    }));
  } catch {
    return null;
  }
}

// ── protocol-wide analytics (Analytics page) ─────────────────────────────────

export type FeeFlowBase = {
  volumeUsdAll: number;
  parentBurnTokens: number; // $BALLAST burned via FeeRouter parent-burn families
  buybackRuns: number;
  buybackBallastTotal: number; // $BALLAST bought+burned by the protocol buyback
  buybackByAsset: { asset: string; amountIn: number; ballastBought: number }[];
};

/** Raw fee-flow inputs from the indexer. USD fee splits are layered on in the
 *  endpoint from the LIVE FeeConfig bps (never hardcoded here). */
export async function getFeeFlowBase(): Promise<FeeFlowBase | null> {
  try {
    const volRows = await query<{ v: string }>(`SELECT coalesce(sum(usd_size), 0) AS v FROM swaps`);
    if (volRows === null) return null;
    const pbRows = await query<{ v: string }>(
      `SELECT coalesce(sum(amount), 0) AS v FROM fee_distributions WHERE kind = 'parent_burn'`,
    );
    const bbCount = await query<{ n: string }>(`SELECT count(*) AS n FROM buyback_runs`);
    const bbTotal = await query<{ v: string }>(`SELECT coalesce(sum(amount_burned), 0) AS v FROM buyback_runs`);
    const bbByAsset = await query<{ asset: string | null; amt_in: string; bought: string }>(
      `SELECT asset, coalesce(sum(amount_in), 0) AS amt_in, coalesce(sum(amount_burned), 0) AS bought
       FROM buyback_runs GROUP BY asset ORDER BY bought DESC`,
    );
    return {
      volumeUsdAll: num(volRows[0]?.v),
      parentBurnTokens: num(pbRows?.[0]?.v),
      buybackRuns: Math.floor(num(bbCount?.[0]?.n)),
      buybackBallastTotal: num(bbTotal?.[0]?.v),
      buybackByAsset: (bbByAsset ?? []).map((r) => ({
        asset: (r.asset ?? "").toLowerCase(),
        amountIn: num(r.amt_in),
        ballastBought: num(r.bought),
      })),
    };
  } catch {
    return null;
  }
}

export type BurnByToken = { token: string; symbol: string | null; burnedTokens: number };
export type BuybackRun = {
  burner: string;
  asset: string | null;
  amountIn: number;
  ballastBought: number;
  ts: number;
  tx: string;
};
export type BurnTracker = { byToken: BurnByToken[]; totalBurned: number; buybacks: BuybackRun[] };

/** Cumulative $BALLAST at the dead address (from indexed Transfer→dead) per token,
 *  plus the full buyback-run list. */
export async function getBurnTracker(limit = 50): Promise<BurnTracker | null> {
  try {
    const byToken = await query<{ token: string; symbol: string | null; v: string }>(
      `SELECT b.token, l.symbol, coalesce(sum(b.amount), 0) AS v
       FROM burns b LEFT JOIN launches l ON l.token = b.token
       GROUP BY b.token, l.symbol ORDER BY v DESC`,
    );
    if (byToken === null) return null;
    const runs = await query<{ burner: string; asset: string | null; amount_in: string; amount_burned: string; ts: string; tx: string }>(
      `SELECT burner, asset, amount_in, amount_burned, extract(epoch FROM ts) AS ts, tx
       FROM buyback_runs ORDER BY block DESC, log_index DESC LIMIT $1`,
      [Math.min(Math.max(1, Math.floor(limit)), 500)],
    );
    const tokens = byToken.map((r) => ({ token: r.token, symbol: r.symbol, burnedTokens: num(r.v) }));
    return {
      byToken: tokens,
      totalBurned: tokens.reduce((s, t) => s + t.burnedTokens, 0),
      buybacks: (runs ?? []).map((r) => ({
        burner: r.burner,
        asset: r.asset ? r.asset.toLowerCase() : null,
        amountIn: num(r.amount_in),
        ballastBought: num(r.amount_burned),
        ts: Math.floor(num(r.ts)),
        tx: r.tx,
      })),
    };
  } catch {
    return null;
  }
}

export type TopToken = { token: string; symbol: string | null; volumeUsd: number; trades: number };

export async function getTopTokensByVolume(limit = 10): Promise<TopToken[] | null> {
  try {
    const rows = await query<{ token: string; symbol: string | null; v: string; n: string }>(
      `SELECT s.token, l.symbol, coalesce(sum(s.usd_size), 0) AS v, count(*) AS n
       FROM swaps s LEFT JOIN launches l ON l.token = s.token
       GROUP BY s.token, l.symbol
       HAVING coalesce(sum(s.usd_size), 0) > 0
       ORDER BY v DESC LIMIT $1`,
      [Math.min(Math.max(1, Math.floor(limit)), 100)],
    );
    if (rows === null) return null;
    return rows.map((r) => ({ token: r.token, symbol: r.symbol, volumeUsd: num(r.v), trades: Math.floor(num(r.n)) }));
  } catch {
    return null;
  }
}

export type TopCreator = { creator: string; tokenCount: number; volumeUsd: number };

/** Creators ranked by the trading volume of the tokens they launched. The fee USD
 *  is layered on in the endpoint from the live fee + creator-split bps. */
export async function getTopCreatorsByVolume(limit = 10): Promise<TopCreator[] | null> {
  try {
    const rows = await query<{ creator: string; tokens: string; v: string }>(
      `SELECT l.creator, count(DISTINCT l.token) AS tokens, coalesce(sum(s.usd_size), 0) AS v
       FROM launches l JOIN swaps s ON s.token = l.token
       GROUP BY l.creator
       HAVING coalesce(sum(s.usd_size), 0) > 0
       ORDER BY v DESC LIMIT $1`,
      [Math.min(Math.max(1, Math.floor(limit)), 100)],
    );
    if (rows === null) return null;
    return rows.map((r) => ({ creator: r.creator, tokenCount: Math.floor(num(r.tokens)), volumeUsd: num(r.v) }));
  } catch {
    return null;
  }
}

export type Family = { parent: string; routers: string[]; burnedTokens: number };

/** FeeRouter parent-burn families: each parent token and the child routers that
 *  have burned it. Empty until a family fee-router is deployed (honest). */
export async function getFamilies(): Promise<Family[] | null> {
  try {
    const rows = await query<{ parent: string; routers: string[]; v: string }>(
      `SELECT recipient AS parent, array_agg(DISTINCT router) AS routers, coalesce(sum(amount), 0) AS v
       FROM fee_distributions WHERE kind = 'parent_burn' AND recipient IS NOT NULL
       GROUP BY recipient ORDER BY v DESC`,
    );
    if (rows === null) return null;
    return rows.map((r) => ({
      parent: r.parent,
      routers: (r.routers ?? []).filter(Boolean),
      burnedTokens: num(r.v),
    }));
  } catch {
    return null;
  }
}

export type RoundupStats = {
  count: number;
  ethIn: number;
  byStock: { stock: string; count: number; stockOut: number }[];
};

export async function getRoundupStats(): Promise<RoundupStats | null> {
  try {
    const totals = await query<{ n: string; eth: string }>(
      `SELECT count(*) AS n, coalesce(sum(eth_in), 0) AS eth FROM roundups`,
    );
    if (totals === null) return null;
    const byStock = await query<{ stock: string; n: string; out: string }>(
      `SELECT stock, count(*) AS n, coalesce(sum(stock_out), 0) AS out
       FROM roundups GROUP BY stock ORDER BY out DESC`,
    );
    return {
      count: Math.floor(num(totals[0]?.n)),
      ethIn: num(totals[0]?.eth),
      byStock: (byStock ?? []).map((r) => ({ stock: r.stock.toLowerCase(), count: Math.floor(num(r.n)), stockOut: num(r.out) })),
    };
  } catch {
    return null;
  }
}

export type LaunchLite = { token: string; treasury: string; symbol: string | null; creator: string };

/** All indexed launches (token/treasury/creator/symbol) for endpoint-side chain
 *  aggregation (e.g. per-stock treasury exposure via BackingLens). */
export async function getLaunchesLite(): Promise<LaunchLite[] | null> {
  try {
    const rows = await query<{ token: string; treasury: string; symbol: string | null; creator: string }>(
      `SELECT token, treasury, symbol, creator FROM launches ORDER BY launch_block ASC`,
    );
    if (rows === null) return null;
    return rows.map((r) => ({ token: r.token, treasury: r.treasury, symbol: r.symbol, creator: r.creator }));
  } catch {
    return null;
  }
}

export type PairingRow = { token: string; hasWeth: boolean; hasStock: boolean };

/** Per-token pool pairing (does the token have a WETH pool, a stock pool, or both),
 *  so the endpoint can classify the pairing mix. */
export async function getPairingRows(weth: string): Promise<PairingRow[] | null> {
  try {
    const rows = await query<{ token: string; has_weth: boolean; has_stock: boolean }>(
      `SELECT l.token,
         bool_or(p.quote_asset = $1) AS has_weth,
         bool_or(p.quote_asset IS NOT NULL AND p.quote_asset <> $1) AS has_stock
       FROM launches l LEFT JOIN pools p ON p.token = l.token
       GROUP BY l.token`,
      [weth.toLowerCase()],
    );
    if (rows === null) return null;
    return rows.map((r) => ({ token: r.token, hasWeth: Boolean(r.has_weth), hasStock: Boolean(r.has_stock) }));
  } catch {
    return null;
  }
}
