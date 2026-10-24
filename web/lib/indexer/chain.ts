import "server-only";
import { getAbiItem, formatUnits, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { serverClient } from "@/lib/serverChain";
import {
  ballastFactoryAbi,
  poolManagerAbi,
  erc20Abi,
  feeRouterV2Abi,
  aggregatorV3Abi,
} from "@/lib/abis";
import { buybackBurnedAbi } from "@/lib/tg/decode";
import { classifySwap } from "@/lib/tg/swapDirection";
import { candidatePoolKeys } from "@/lib/pool";
import {
  FACTORY_ADDRESSES,
  POOL_MANAGER_ADDRESS,
  BUYBACK_ADDRESS,
  BUYBACK_V2_ADDRESS,
  WETH_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  DEAD_ADDRESS,
} from "@/lib/contracts";
import { getReadDb } from "./db";

// Server-side chain → Postgres indexing core. Reuses the project's existing
// getLogs block-range chunking (lib/tg/poll), the v4 Swap classifier
// (lib/tg/swapDirection), and the shared viem client (lib/serverChain). Work is
// BOUNDED per call by the caller's block window so each Vercel invocation stays
// under the function timeout; progress is persisted in indexer_cursor so the next
// call resumes from exactly where this one stopped.

// The public RPC caps eth_getLogs span — stay well under it (same value the TG
// poller uses). Wide windows are split; each chunk is independently try/caught so
// one transient failure doesn't drop the rest of the range.
const GETLOGS_MAX_SPAN = 9_000_000n;

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = DEAD_ADDRESS.toLowerCase();
const TOKEN_DECIMALS = 18; // Ballast launch tokens are always 18-decimal ERC-8056.

/** The single unified indexing job. All categories advance together so the DB is
 *  never partially-indexed per-category for a given block height. */
export const DEFAULT_CURSOR = "main";

/** Genesis block for a cold backfill. Set INDEXER_START_BLOCK to the first factory
 *  deploy block to make the initial backfill tractable (default 0). */
export function genesisBlock(): bigint {
  const v = process.env.INDEXER_START_BLOCK;
  try {
    const n = v ? BigInt(v) : 0n;
    return n >= 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

export function indexerChainReady(): boolean {
  return Boolean(POOL_MANAGER_ADDRESS) && FACTORY_ADDRESSES.length > 0;
}

type DecodedLog = {
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
  address: Address;
};

type Client = ReturnType<typeof serverClient>;
type SqlClient = NonNullable<ReturnType<typeof getReadDb>>;

// ── RPC helpers ──────────────────────────────────────────────────────────────

async function getLogsChunked(
  client: Client,
  params: { address?: Address | Address[]; abi: Abi; eventName: string; from: bigint; to: bigint },
): Promise<DecodedLog[]> {
  const event = getAbiItem({ abi: params.abi, name: params.eventName }) as AbiEvent;
  const out: DecodedLog[] = [];
  for (let lo = params.from; lo <= params.to; lo += GETLOGS_MAX_SPAN) {
    const hiCandidate = lo + GETLOGS_MAX_SPAN - 1n;
    const hi = hiCandidate > params.to ? params.to : hiCandidate;
    try {
      const logs = (await client.getLogs({
        address: params.address as never,
        event: event as never,
        fromBlock: lo,
        toBlock: hi,
      })) as Array<{
        args?: Record<string, unknown>;
        blockNumber: bigint | null;
        transactionHash: Hex | null;
        logIndex: number | null;
        address: Address;
      }>;
      for (const log of logs) {
        if (log.blockNumber == null || log.transactionHash == null || log.logIndex == null) continue;
        out.push({
          args: (log.args ?? {}) as Record<string, unknown>,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          address: log.address as Address,
        });
      }
    } catch {
      // best-effort per chunk (same tolerance as the TG poller / eventBackfill)
    }
  }
  return out;
}

/** Timestamps (unix seconds) for a set of block numbers, limited concurrency. */
async function blockTimestamps(client: Client, blocks: Iterable<bigint>): Promise<Map<string, number>> {
  const unique = [...new Set([...blocks].map((b) => b.toString()))];
  const out = new Map<string, number>();
  const CONCURRENCY = 10;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const slice = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (b) => {
        try {
          const blk = await client.getBlock({ blockNumber: BigInt(b) });
          return [b, Number(blk.timestamp)] as const;
        } catch {
          return [b, 0] as const;
        }
      }),
    );
    for (const [b, ts] of results) out.set(b, ts);
  }
  return out;
}

function isoFromSec(sec: number): string {
  return new Date((sec > 0 ? sec : 0) * 1000).toISOString();
}

/** Current ETH/USD from the Chainlink feed, or undefined. Applied to WETH-quoted
 *  trades to derive usd_size — an approximation for historical trades (the feed is
 *  read at indexing time, not per-block); see README. */
async function ethUsdNow(client: Client): Promise<number | undefined> {
  if (!ETH_USD_FEED_ADDRESS) return undefined;
  try {
    const reads = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "latestRoundData" },
        { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "decimals" },
      ],
    });
    if (reads[0]?.status !== "success" || reads[1]?.status !== "success") return undefined;
    const answer = (reads[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer <= 0n) return undefined;
    const dec = reads[1].result as number;
    return Number(formatUnits(answer, dec));
  } catch {
    return undefined;
  }
}

async function erc20Field(
  client: Client,
  addrs: Address[],
  field: "name" | "symbol" | "decimals",
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const unique = [...new Set(addrs.map((a) => a.toLowerCase()))] as Address[];
  if (unique.length === 0) return out;
  const res = await client.multicall({
    allowFailure: true,
    contracts: unique.map((address) => ({ address, abi: erc20Abi, functionName: field as never })),
  });
  unique.forEach((a, i) => {
    const r = res[i];
    if (r?.status === "success") out.set(a, r.result);
  });
  return out;
}

// ── write helpers ────────────────────────────────────────────────────────────

/** Multi-row parameterized INSERT, chunked to stay under Postgres' parameter cap. */
async function bulkInsert(
  sql: SqlClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
): Promise<void> {
  if (rows.length === 0) return;
  const rowsPerBatch = Math.max(1, Math.floor(5000 / columns.length));
  for (let i = 0; i < rows.length; i += rowsPerBatch) {
    const batch = rows.slice(i, i + rowsPerBatch);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of batch) {
      const ph: string[] = [];
      for (const val of row) {
        params.push(val);
        ph.push(`$${params.length}`);
      }
      tuples.push(`(${ph.join(",")})`);
    }
    const text = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ${conflict}`;
    await sql(text, params);
  }
}

export async function getCursor(name: string): Promise<bigint | null> {
  const sql = getReadDb();
  if (!sql) return null;
  const rows = (await sql(`SELECT last_block FROM indexer_cursor WHERE name = $1`, [name])) as Array<{
    last_block: string | number | bigint;
  }>;
  const row = rows[0];
  if (!row) return null;
  return BigInt(row.last_block);
}

/** Reset a cursor so the next backfill starts from genesis again. Used after an
 *  indexing-logic fix (e.g. widening pool resolution) to re-scan history — swap
 *  rows are idempotent (ON CONFLICT DO NOTHING), so a re-scan only fills gaps. */
export async function resetCursor(name: string): Promise<boolean> {
  const sql = getReadDb();
  if (!sql) return false;
  await sql(`DELETE FROM indexer_cursor WHERE name = $1`, [name]);
  return true;
}

async function setCursor(sql: SqlClient, name: string, block: bigint): Promise<void> {
  await sql(
    `INSERT INTO indexer_cursor (name, last_block, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
    [name, block.toString()],
  );
}

// ── the main range indexer ───────────────────────────────────────────────────

export type IndexResult = {
  fromBlock: string;
  toBlock: string;
  counts: Record<string, number>;
};

/**
 * Index every category over [fromBlock, toBlock] and advance `cursorName` to
 * toBlock. Idempotent at the row level (ON CONFLICT DO NOTHING on natural keys),
 * so re-running an overlapping range never double-counts.
 */
export async function indexRange(
  fromBlock: bigint,
  toBlock: bigint,
  cursorName: string = DEFAULT_CURSOR,
): Promise<IndexResult> {
  const sql = getReadDb();
  if (!sql) throw new Error("indexer not configured");
  if (!POOL_MANAGER_ADDRESS) throw new Error("POOL_MANAGER_ADDRESS not set");
  const client = serverClient();
  const counts: Record<string, number> = {};

  // 1. Pull every category's logs for the window (bounded, chunked).
  const [launchLogs, poolSeededLogs, swapLogs, splitSched, splitApplied, splitInstant, parentBurned, buybackLogs] =
    await Promise.all([
      Promise.all(FACTORY_ADDRESSES.map((f) => getLogsChunked(client, { address: f, abi: ballastFactoryAbi, eventName: "Launched", from: fromBlock, to: toBlock }))).then((a) => a.flat()),
      Promise.all(FACTORY_ADDRESSES.map((f) => getLogsChunked(client, { address: f, abi: ballastFactoryAbi, eventName: "PoolSeeded", from: fromBlock, to: toBlock }))).then((a) => a.flat()),
      getLogsChunked(client, { address: POOL_MANAGER_ADDRESS, abi: poolManagerAbi, eventName: "Swap", from: fromBlock, to: toBlock }),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "SplitScheduled", from: fromBlock, to: toBlock }),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "SplitApplied", from: fromBlock, to: toBlock }),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "SplitAppliedInstant", from: fromBlock, to: toBlock }),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "ParentBurned", from: fromBlock, to: toBlock }),
      indexBuybacks(client, fromBlock, toBlock),
    ]);

  // 2. Resolve quote-asset decimals for any newly-seeded pools, then persist pools.
  const newQuoteAssets = poolSeededLogs.map((l) => l.args.quoteAsset as Address).filter(Boolean);
  const quoteDecimals = await erc20Field(client, newQuoteAssets, "decimals");
  const poolRows: unknown[][] = [];
  for (const l of poolSeededLogs) {
    const token = (l.args.token as Address)?.toLowerCase();
    const quote = (l.args.quoteAsset as Address)?.toLowerCase();
    const poolId = (l.args.poolId as Hex)?.toLowerCase();
    if (!token || !quote || !poolId) continue;
    const dec = Number(quoteDecimals.get(quote) ?? 18);
    poolRows.push([poolId, token, quote, dec, Number(l.args.openTick ?? 0), l.blockNumber.toString()]);
  }

  // 3. Timestamps for every block that carries an event we store.
  const tsBlocks = new Set<bigint>();
  for (const l of [...launchLogs, ...swapLogs, ...splitSched, ...splitApplied, ...splitInstant, ...parentBurned, ...buybackLogs]) {
    tsBlocks.add(l.blockNumber);
  }
  for (const l of poolSeededLogs) tsBlocks.add(l.blockNumber);
  const tsMap = await blockTimestamps(client, tsBlocks);
  const tsOf = (b: bigint): number => tsMap.get(b.toString()) ?? 0;

  // Backfill pool rows' ts now that we have them.
  for (const r of poolRows) r.push(isoFromSec(tsOf(BigInt(r[5] as string))));

  // 4. Launches (resolve name/symbol).
  const launchTokens = launchLogs.map((l) => l.args.token as Address).filter(Boolean);
  const names = await erc20Field(client, launchTokens, "name");
  const symbols = await erc20Field(client, launchTokens, "symbol");
  const launchRows: unknown[][] = [];
  for (const l of launchLogs) {
    const token = (l.args.token as Address)?.toLowerCase();
    if (!token) continue;
    launchRows.push([
      token,
      (l.args.treasury as Address).toLowerCase(),
      (l.args.creator as Address).toLowerCase(),
      l.address.toLowerCase(),
      (l.args.id as bigint)?.toString() ?? null,
      l.blockNumber.toString(),
      isoFromSec(tsOf(l.blockNumber)),
      (names.get(token) as string) ?? null,
      (symbols.get(token) as string) ?? null,
      (l.args.metadataURI as string) ?? null,
    ]);
  }

  // 5. Build the pool map (existing pools + newly seeded) to resolve swaps.
  const existingPools = (await sql(
    `SELECT pool_id, token, quote_asset, quote_decimals FROM pools`,
  )) as Array<{ pool_id: string; token: string; quote_asset: string; quote_decimals: number }>;
  const poolMap = new Map<string, { token: string; quote: string; dec: number }>();
  for (const p of existingPools) poolMap.set(p.pool_id.toLowerCase(), { token: p.token, quote: p.quote_asset, dec: Number(p.quote_decimals) });
  for (const r of poolRows) poolMap.set(r[0] as string, { token: r[1] as string, quote: r[2] as string, dec: r[3] as number });

  const ethUsd = await ethUsdNow(client);
  const wethLc = WETH_ADDRESS?.toLowerCase();

  // Also map the WETH poolId of EVERY known token, computed deterministically
  // across all generation hooks — the same way the app resolves pools. PoolSeeded
  // is only emitted by the multi-quote (gen-4) factory, so prior generations
  // (which emit Graduated, with no poolId) would otherwise never map their pool
  // and every one of their swaps would be dropped. Cheap (keccak only) and
  // idempotent (don't clobber an exact PoolSeeded row).
  if (WETH_ADDRESS && wethLc) {
    const known = (await sql(`SELECT token FROM launches`)) as Array<{ token: string }>;
    const tokens = new Set<string>(known.map((k) => k.token.toLowerCase()));
    for (const r of launchRows) tokens.add((r[0] as string).toLowerCase());
    for (const t of tokens) {
      for (const c of candidatePoolKeys(t as Address, WETH_ADDRESS)) {
        const pid = c.id.toLowerCase();
        if (!poolMap.has(pid)) poolMap.set(pid, { token: t, quote: wethLc, dec: 18 });
      }
    }
  }

  // 6. Swaps — only those whose poolId is one of ours.
  const swapRows: unknown[][] = [];
  const touchedSwapTokens = new Set<string>();
  let minSwapTs = Number.POSITIVE_INFINITY;
  let maxSwapTs = 0;
  for (const l of swapLogs) {
    const poolId = (l.args.id as Hex)?.toLowerCase();
    const info = poolId ? poolMap.get(poolId) : undefined;
    if (!info) continue;
    const token = info.token as Address;
    const quote = info.quote as Address;
    const amount0 = l.args.amount0 as bigint;
    const amount1 = l.args.amount1 as bigint;
    const { side, tokenAbs, quoteAbs } = classifySwap(token, quote, amount0, amount1);
    const amountToken = formatUnits(tokenAbs, TOKEN_DECIMALS);
    const amountQuote = formatUnits(quoteAbs, info.dec);
    const nTok = Number(amountToken);
    const nQuote = Number(amountQuote);
    const price = nTok > 0 ? nQuote / nTok : null;
    const usdSize = wethLc && quote.toLowerCase() === wethLc && ethUsd !== undefined ? nQuote * ethUsd : null;
    const ts = tsOf(l.blockNumber);
    swapRows.push([
      poolId,
      token.toLowerCase(),
      quote.toLowerCase(),
      side,
      amountToken,
      amountQuote,
      price,
      usdSize,
      (l.args.sender as Address).toLowerCase(),
      l.blockNumber.toString(),
      isoFromSec(ts),
      l.txHash,
      l.logIndex,
    ]);
    touchedSwapTokens.add(token.toLowerCase());
    if (ts > 0) {
      if (ts < minSwapTs) minSwapTs = ts;
      if (ts > maxSwapTs) maxSwapTs = ts;
    }
  }

  // 7. Split events + fee distributions (ParentBurned) + buyback runs.
  const splitRows: unknown[][] = [];
  const pushSplit = (logs: DecodedLog[], kind: "scheduled" | "applied" | "applied_instant") => {
    for (const l of logs) {
      splitRows.push([
        l.address.toLowerCase(),
        null,
        kind,
        Number(l.args.creatorBps ?? 0),
        Number(l.args.treasuryBps ?? 0),
        Number(l.args.buybackBps ?? 0),
        Number(l.args.parentBurnBps ?? 0),
        Number(l.args.rewardsBps ?? 0),
        l.args.effectiveAt !== undefined ? isoFromSec(Number(l.args.effectiveAt as bigint)) : null,
        l.blockNumber.toString(),
        isoFromSec(tsOf(l.blockNumber)),
        l.txHash,
        l.logIndex,
      ]);
    }
  };
  pushSplit(splitSched, "scheduled");
  pushSplit(splitApplied, "applied");
  pushSplit(splitInstant, "applied_instant");

  const feeRows: unknown[][] = [];
  for (const l of parentBurned) {
    feeRows.push([
      null,
      l.address.toLowerCase(),
      (l.args.parent as Address).toLowerCase(),
      formatUnits(l.args.parentOut as bigint, TOKEN_DECIMALS),
      "parent_burn",
      l.blockNumber.toString(),
      isoFromSec(tsOf(l.blockNumber)),
      l.txHash,
      l.logIndex,
    ]);
  }

  const buybackRows: unknown[][] = [];
  for (const l of buybackLogs) {
    buybackRows.push([
      (l.args.caller as Address).toLowerCase(),
      (l.args.asset as Address)?.toLowerCase() ?? null,
      formatUnits((l.args.spent as bigint) ?? 0n, TOKEN_DECIMALS),
      formatUnits((l.args.ballastBought as bigint) ?? 0n, TOKEN_DECIMALS),
      l.args.totalBallastBurned !== undefined ? formatUnits(l.args.totalBallastBurned as bigint, TOKEN_DECIMALS) : null,
      l.blockNumber.toString(),
      isoFromSec(tsOf(l.blockNumber)),
      l.txHash,
      l.logIndex,
    ]);
  }

  // 8. Transfers → balances (net deltas) + burns (to dead address), for known tokens.
  const knownTokenRows = (await sql(`SELECT token FROM launches`)) as Array<{ token: string }>;
  const knownTokens = new Set<string>(knownTokenRows.map((r) => r.token.toLowerCase()));
  for (const r of launchRows) knownTokens.add(r[0] as string);
  const { balanceRows, burnRows, touchedBurnDays } = await indexTransfers(
    client,
    sql,
    [...knownTokens] as Address[],
    fromBlock,
    toBlock,
  );

  // 9. Persist everything. Natural-key conflicts → DO NOTHING (idempotent).
  await bulkInsert(sql, "pools", ["pool_id", "token", "quote_asset", "quote_decimals", "open_tick", "block", "ts"], poolRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]]), "ON CONFLICT (pool_id) DO NOTHING");
  await bulkInsert(sql, "launches", ["token", "treasury", "creator", "factory", "launch_id", "launch_block", "launch_ts", "name", "symbol", "metadata_uri"], launchRows, "ON CONFLICT (token) DO NOTHING");
  await bulkInsert(sql, "swaps", ["pool_id", "token", "quote_asset", "side", "amount_token", "amount_quote", "price", "usd_size", "trader", "block_number", "block_ts", "tx_hash", "log_index"], swapRows, "ON CONFLICT (tx_hash, log_index) DO NOTHING");
  await bulkInsert(sql, "split_events", ["router", "token", "kind", "creator_bps", "treasury_bps", "buyback_bps", "parent_burn_bps", "rewards_bps", "effective_at", "block", "ts", "tx", "log_index"], splitRows, "ON CONFLICT (tx, log_index) DO NOTHING");
  await bulkInsert(sql, "fee_distributions", ["token", "router", "recipient", "amount", "kind", "block", "ts", "tx", "log_index"], feeRows, "ON CONFLICT (tx, log_index) DO NOTHING");
  await bulkInsert(sql, "buyback_runs", ["burner", "asset", "amount_in", "amount_burned", "total_burned", "block", "ts", "tx", "log_index"], buybackRows, "ON CONFLICT (tx, log_index) DO NOTHING");
  await bulkInsert(sql, "burns", ["token", "from_addr", "amount", "block", "ts", "tx", "log_index"], burnRows, "ON CONFLICT (tx, log_index) DO NOTHING");

  // Balances: upsert with increment (deltas may be negative).
  await upsertBalances(sql, balanceRows);

  // 10. Derived rollups: OHLC candles + daily rollups for touched tokens/days.
  if (swapRows.length > 0 && Number.isFinite(minSwapTs)) {
    await rollupOhlc(sql, [...touchedSwapTokens], minSwapTs, maxSwapTs);
  }
  await rollupDaily(sql, collectTouchedDays(swapRows, launchRows, touchedBurnDays));

  // 11. Advance the cursor.
  await setCursor(sql, cursorName, toBlock);

  counts.launches = launchRows.length;
  counts.pools = poolRows.length;
  counts.swaps = swapRows.length;
  counts.splits = splitRows.length;
  counts.feeDistributions = feeRows.length;
  counts.buybacks = buybackRows.length;
  counts.burns = burnRows.length;
  counts.balanceDeltas = balanceRows.length;

  return { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), counts };
}

// ── sub-indexers ─────────────────────────────────────────────────────────────

async function indexBuybacks(client: Client, from: bigint, to: bigint): Promise<DecodedLog[]> {
  const addrs = [BUYBACK_ADDRESS, BUYBACK_V2_ADDRESS].filter(Boolean) as Address[];
  if (addrs.length === 0) return [];
  const all = await Promise.all(
    addrs.map((a) => getLogsChunked(client, { address: a, abi: buybackBurnedAbi as unknown as Abi, eventName: "BuybackBurned", from, to })),
  );
  return all.flat();
}

async function indexTransfers(
  client: Client,
  sql: SqlClient,
  tokens: Address[],
  from: bigint,
  to: bigint,
): Promise<{ balanceRows: unknown[][]; burnRows: unknown[][]; touchedBurnDays: Set<string> }> {
  if (tokens.length === 0) return { balanceRows: [], burnRows: [], touchedBurnDays: new Set() };
  const logs = await getLogsChunked(client, { address: tokens, abi: erc20Abi, eventName: "Transfer", from, to });
  if (logs.length === 0) return { balanceRows: [], burnRows: [], touchedBurnDays: new Set() };

  // Net balance deltas per (token, holder) within this window.
  const deltas = new Map<string, bigint>();
  const lastBlock = new Map<string, bigint>();
  const burnLogs: DecodedLog[] = [];
  const tsBlocks = new Set<bigint>();
  for (const l of logs) {
    const token = l.address.toLowerCase();
    const fromAddr = (l.args.from as Address)?.toLowerCase();
    const toAddr = (l.args.to as Address)?.toLowerCase();
    const value = (l.args.value as bigint) ?? 0n;
    if (fromAddr && fromAddr !== ZERO) {
      const k = `${token}|${fromAddr}`;
      deltas.set(k, (deltas.get(k) ?? 0n) - value);
      lastBlock.set(k, l.blockNumber);
    }
    if (toAddr && toAddr !== ZERO) {
      const k = `${token}|${toAddr}`;
      deltas.set(k, (deltas.get(k) ?? 0n) + value);
      lastBlock.set(k, l.blockNumber);
    }
    if (toAddr === DEAD) {
      burnLogs.push(l);
      tsBlocks.add(l.blockNumber);
    }
  }

  const tsMap = await blockTimestamps(client, tsBlocks);
  const touchedBurnDays = new Set<string>();
  const burnRows: unknown[][] = [];
  for (const l of burnLogs) {
    const sec = tsMap.get(l.blockNumber.toString()) ?? 0;
    const iso = isoFromSec(sec);
    burnRows.push([
      l.address.toLowerCase(),
      (l.args.from as Address).toLowerCase(),
      formatUnits((l.args.value as bigint) ?? 0n, TOKEN_DECIMALS),
      l.blockNumber.toString(),
      iso,
      l.txHash,
      l.logIndex,
    ]);
    touchedBurnDays.add(iso.slice(0, 10));
  }

  const balanceRows: unknown[][] = [];
  for (const [k, delta] of deltas) {
    const [token, holder] = k.split("|");
    balanceRows.push([token, holder, formatUnits(delta, TOKEN_DECIMALS), (lastBlock.get(k) ?? 0n).toString()]);
  }
  void sql;
  return { balanceRows, burnRows, touchedBurnDays };
}

async function upsertBalances(sql: SqlClient, rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const rowsPerBatch = Math.max(1, Math.floor(5000 / 4));
  for (let i = 0; i < rows.length; i += rowsPerBatch) {
    const batch = rows.slice(i, i + rowsPerBatch);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of batch) {
      const ph: string[] = [];
      for (const val of row) {
        params.push(val);
        ph.push(`$${params.length}`);
      }
      tuples.push(`(${ph.join(",")})`);
    }
    await sql(
      `INSERT INTO balances (token, holder, balance, last_block) VALUES ${tuples.join(",")}
       ON CONFLICT (token, holder) DO UPDATE SET
         balance = balances.balance + EXCLUDED.balance,
         last_block = GREATEST(balances.last_block, EXCLUDED.last_block)`,
      params,
    );
  }
}

const BUCKETS: { label: string; secs: number }[] = [
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "1h", secs: 3600 },
  { label: "4h", secs: 14400 },
  { label: "1D", secs: 86400 },
];

/**
 * Recompute OHLC candles for the given tokens over the bucket-aligned window
 * covering [minTs, maxTs]. The SELECT reads the FULL swaps table (not just this
 * chunk) bounded to that window, so every touched bucket is recomputed COMPLETELY
 * from all swaps indexed so far — never a partial bucket.
 */
async function rollupOhlc(sql: SqlClient, tokens: string[], minTs: number, maxTs: number): Promise<void> {
  if (tokens.length === 0) return;
  for (const b of BUCKETS) {
    const lower = Math.floor(minTs / b.secs) * b.secs;
    await sql(
      `INSERT INTO ohlc (token, bucket, ts, open, high, low, close, volume_usd)
       SELECT token, $1 AS bucket,
         to_timestamp(floor(extract(epoch FROM block_ts) / $2) * $2) AS ts,
         (array_agg(price ORDER BY block_number, log_index))[1] AS open,
         max(price) AS high,
         min(price) AS low,
         (array_agg(price ORDER BY block_number DESC, log_index DESC))[1] AS close,
         coalesce(sum(usd_size), 0) AS volume_usd
       FROM swaps
       WHERE token = ANY($3)
         AND price IS NOT NULL
         AND block_ts >= to_timestamp($4)
         AND block_ts <= to_timestamp($5)
       GROUP BY token, ts
       ON CONFLICT (token, bucket, ts) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume_usd = EXCLUDED.volume_usd`,
      [b.label, b.secs, tokens, lower, maxTs],
    );
  }
}

function collectTouchedDays(swapRows: unknown[][], launchRows: unknown[][], burnDays: Set<string>): string[] {
  const days = new Set<string>(burnDays);
  for (const r of swapRows) days.add(String(r[10]).slice(0, 10)); // block_ts iso
  for (const r of launchRows) days.add(String(r[6]).slice(0, 10)); // launch_ts iso
  return [...days].filter(Boolean);
}

/** Recompute daily_rollups fully from the base tables for each touched day. */
async function rollupDaily(sql: SqlClient, days: string[]): Promise<void> {
  if (days.length === 0) return;
  await sql(
    `INSERT INTO daily_rollups (day, volume_usd, trades, launches, burned_tokens)
     SELECT d AS day,
       coalesce(s.vol, 0), coalesce(s.cnt, 0), coalesce(l.cnt, 0), coalesce(b.amt, 0)
     FROM unnest($1::date[]) AS d
     LEFT JOIN (
       SELECT block_ts::date AS day, sum(coalesce(usd_size, 0)) AS vol, count(*) AS cnt
       FROM swaps GROUP BY 1
     ) s ON s.day = d
     LEFT JOIN (
       SELECT launch_ts::date AS day, count(*) AS cnt FROM launches GROUP BY 1
     ) l ON l.day = d
     LEFT JOIN (
       SELECT ts::date AS day, sum(amount) AS amt FROM burns GROUP BY 1
     ) b ON b.day = d
     ON CONFLICT (day) DO UPDATE SET
       volume_usd = EXCLUDED.volume_usd, trades = EXCLUDED.trades,
       launches = EXCLUDED.launches, burned_tokens = EXCLUDED.burned_tokens`,
    [days],
  );
}

// ── treasury snapshots (called by cron, best-effort) ─────────────────────────

/** Write a point-in-time backing snapshot for each known treasury via BackingLens.
 *  Best-effort: any read failure is skipped, never thrown. */
export async function snapshotTreasuries(limit = 50): Promise<number> {
  const sql = getReadDb();
  if (!sql) return 0;
  const { LENS_ADDRESS } = await import("@/lib/contracts");
  if (!LENS_ADDRESS) return 0;
  const { backingLensAbi } = await import("@/lib/abis");
  const rows = (await sql(
    `SELECT token, treasury FROM launches ORDER BY launch_block DESC LIMIT $1`,
    [limit],
  )) as Array<{ token: string; treasury: string }>;
  if (rows.length === 0) return 0;
  const client = serverClient();
  let block: bigint;
  try {
    block = await client.getBlockNumber();
  } catch {
    return 0;
  }
  const nowIso = new Date().toISOString();
  const snapRows: unknown[][] = [];
  try {
    const res = await client.multicall({
      allowFailure: true,
      contracts: rows.map((r) => ({ address: LENS_ADDRESS, abi: backingLensAbi, functionName: "backingOf" as const, args: [r.treasury as Address] })),
    });
    res.forEach((r, i) => {
      const row = rows[i];
      if (!row || r.status !== "success") return;
      const b = r.result as { totalValueUsd?: bigint; lockedValueUsd?: bigint };
      snapRows.push([
        row.treasury.toLowerCase(),
        row.token.toLowerCase(),
        b.totalValueUsd !== undefined ? formatUnits(b.totalValueUsd, 18) : null,
        b.lockedValueUsd !== undefined ? formatUnits(b.lockedValueUsd, 18) : null,
        block.toString(),
        nowIso,
      ]);
    });
  } catch {
    return 0;
  }
  await bulkInsert(sql, "treasury_snapshots", ["treasury", "token", "total_value_usd", "locked_value_usd", "block", "ts"], snapRows, "");
  return snapRows.length;
}
