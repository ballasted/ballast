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
