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
import { candidatePoolKeys, poolKeyForToken, poolId } from "@/lib/pool";
import {
  FACTORY_ADDRESSES,
  POOL_MANAGER_ADDRESS,
  BUYBACK_ADDRESS,
  BUYBACK_V2_ADDRESS,
  WETH_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  DEAD_ADDRESS,
  hookForFactory,
} from "@/lib/contracts";
import { getReadDb } from "./db";

// Server-side chain → Postgres indexing core. Reuses the project's existing
// getLogs block-range chunking (lib/tg/poll), the v4 Swap classifier
// (lib/tg/swapDirection), and the shared viem client (lib/serverChain). Work is
// BOUNDED per call by the caller's block window so each Vercel invocation stays
// under the function timeout; progress is persisted in indexer_cursor so the next
// call resumes from exactly where this one stopped.

// The public RPC caps eth_getLogs by RESULT COUNT, not just span. Two regimes:
//
//  • SPARSE events (factory Launched/PoolSeeded, FeeRouter splits, buybacks) are
//    few over the whole chain, so a wide span is safe and keeps the scan cheap.
//  • DENSE events (per-pool Swap, per-token Transfer) can emit thousands of logs.
//    A wide, UNFILTERED span silently blows past the result cap and returns
//    almost nothing (the exact bug this file fixes). They are therefore queried
//    FILTERED to one indexed topic (one poolId / one token) AND in a much smaller
//    block span, so each query returns a small, complete result set.
const GETLOGS_MAX_SPAN = 9_000_000n;

/** Block span for DENSE, topic-filtered queries (per-pool Swap, per-token
 *  Transfer). Overridable via INDEXER_DENSE_CHUNK, clamped to [10k, 500k];
 *  default 100k. Smaller = more requests but safer under the RPC result cap. */
function denseSpan(): bigint {
  const v = process.env.INDEXER_DENSE_CHUNK;
  try {
    if (!v) return 100_000n;
    const n = BigInt(v);
    if (n < 10_000n) return 10_000n;
    if (n > 500_000n) return 500_000n;
    return n;
  } catch {
    return 100_000n;
  }
}

/** Concurrency for per-pool / per-token fan-out. The public RPC is rate-limited
 *  (CLAUDE.md), so keep this modest rather than firing every pool at once. */
const DENSE_CONCURRENCY = 6;

/** Promise.all with a bounded worker pool, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = DEAD_ADDRESS.toLowerCase();
const TOKEN_DECIMALS = 18; // Ballast launch tokens are always 18-decimal ERC-8056.

/** The single unified indexing job. All categories advance together so the DB is
 *  never partially-indexed per-category for a given block height. */
export const DEFAULT_CURSOR = "main";

// The Robinhood protocol's own deploy block (docs/robinhood-chain-research.md
// §"Protocol deploy block"). Every BALLAST factory was deployed strictly after
// this, so it is a SAFE lower bound that skips the empty pre-protocol prefix
// without risking skipping any BALLAST launch/swap. INDEXER_START_BLOCK overrides
// it (operator may set it HIGHER — e.g. the first BALLAST factory block — to skip
// even more, or lower to be extra safe).
const GENESIS_FLOOR = 7_887_312n;

/** Genesis block for a cold backfill. Defaults to GENESIS_FLOOR so the initial
 *  backfill doesn't start at block 0; set INDEXER_START_BLOCK to override (e.g.
 *  the first factory deploy block) for an even shorter cold start. */
export function genesisBlock(): bigint {
  const v = process.env.INDEXER_START_BLOCK;
  try {
    if (v !== undefined && v !== "") {
      const n = BigInt(v);
      return n >= 0n ? n : 0n;
    }
  } catch {
    // malformed env → fall through to the safe floor
  }
  return GENESIS_FLOOR;
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
  params: {
    address?: Address | Address[];
    abi: Abi;
    eventName: string;
    from: bigint;
    to: bigint;
    /** Filter by an indexed event argument (e.g. { id: poolId }). Required for
     *  dense events so each query returns a small, complete result set. */
    args?: Record<string, unknown>;
    /** Block span per chunk. Defaults to the wide sparse span; dense callers pass
     *  a much smaller span to stay under the RPC result cap. */
    span?: bigint;
  },
): Promise<DecodedLog[]> {
  const event = getAbiItem({ abi: params.abi, name: params.eventName }) as AbiEvent;
  const span = params.span ?? GETLOGS_MAX_SPAN;
  const out: DecodedLog[] = [];
  for (let lo = params.from; lo <= params.to; lo += span) {
    const hiCandidate = lo + span - 1n;
    const hi = hiCandidate > params.to ? params.to : hiCandidate;
    try {
      const logs = (await client.getLogs({
        address: params.address as never,
        event: event as never,
        args: params.args as never,
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

  const DENSE_SPAN = denseSpan();
  const wethLc = WETH_ADDRESS?.toLowerCase();

  // 1. SPARSE categories — few logs over the whole chain, so the wide span is safe
  //    (factory Launched/PoolSeeded, FeeRouter splits + ParentBurned, buybacks).
  //    Swaps are intentionally NOT fetched here: they're dense and are fetched
  //    PER POOL in step 6, after the pool map is built.
  const [launchLogs, poolSeededLogs, splitSched, splitApplied, splitInstant, parentBurned, buybackLogs] =
    await Promise.all([
      Promise.all(FACTORY_ADDRESSES.map((f) => getLogsChunked(client, { address: f, abi: ballastFactoryAbi, eventName: "Launched", from: fromBlock, to: toBlock }))).then((a) => a.flat()),
      Promise.all(FACTORY_ADDRESSES.map((f) => getLogsChunked(client, { address: f, abi: ballastFactoryAbi, eventName: "PoolSeeded", from: fromBlock, to: toBlock }))).then((a) => a.flat()),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "SplitScheduled", from: fromBlock, to: toBlock }),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "SplitApplied", from: fromBlock, to: toBlock }),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "SplitAppliedInstant", from: fromBlock, to: toBlock }),
      getLogsChunked(client, { abi: feeRouterV2Abi, eventName: "ParentBurned", from: fromBlock, to: toBlock }),
      indexBuybacks(client, fromBlock, toBlock),
    ]);

  // 2. Resolve quote-asset decimals for any newly-seeded pools, then build pool rows.
  const newQuoteAssets = poolSeededLogs.map((l) => l.args.quoteAsset as Address).filter(Boolean);
  const quoteDecimals = await erc20Field(client, newQuoteAssets, "decimals");
  const poolRows: unknown[][] = [];
  for (const l of poolSeededLogs) {
    const token = (l.args.token as Address)?.toLowerCase();
    const quote = (l.args.quoteAsset as Address)?.toLowerCase();
    const pidHex = (l.args.poolId as Hex)?.toLowerCase();
    if (!token || !quote || !pidHex) continue;
    const dec = Number(quoteDecimals.get(quote) ?? 18);
    poolRows.push([pidHex, token, quote, dec, Number(l.args.openTick ?? 0), l.blockNumber.toString()]);
  }

  // 3. Launches (resolve name/symbol). launch_ts (index 6) is backfilled in step 7
  //    once block timestamps are known (swaps are fetched first, below).
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
      null, // launch_ts — filled in step 7
      (names.get(token) as string) ?? null,
      (symbols.get(token) as string) ?? null,
      (l.args.metadataURI as string) ?? null,
    ]);
  }

  // 4. token → owning factory (DB + this window's launches). The factory fixes the
  //    pool's hook and its quote-asset list, exactly like the app resolves pools.
  const knownLaunchRows = (await sql(`SELECT token, factory FROM launches`)) as Array<{ token: string; factory: string }>;
  const tokenFactory = new Map<string, string>();
  for (const r of knownLaunchRows) tokenFactory.set(r.token.toLowerCase(), r.factory.toLowerCase());
  for (const r of launchRows) tokenFactory.set((r[0] as string).toLowerCase(), (r[3] as string).toLowerCase());
  const knownTokens = [...tokenFactory.keys()];

  // 5. Quote assets per token. gen-4 factories expose quoteAssetsOf(token) (which
  //    already includes WETH); prior single-quote factories don't implement it (the
  //    multicall item fails) and could only have graduated against WETH. WETH is
  //    always unioned in so every token at least gets its WETH pool.
  const quoteAssetsByToken = await resolveQuoteAssets(client, knownTokens, tokenFactory);

  // 6a. Build the pool map: EXACT pools (DB + this window's PoolSeeded) PLUS every
  //    derived (token × quoteAsset × hook) poolId, computed the SAME way the app
  //    resolves pools (hookForFactory when the factory is mapped, else probe all
  //    hooks). PoolSeeded is only emitted by gen-4, so prior generations (no
  //    poolId event) would otherwise never map and all their swaps would be lost.
  //    keccak-only, cheap; never clobbers an exact row.
  const existingPools = (await sql(
    `SELECT pool_id, token, quote_asset, quote_decimals FROM pools`,
  )) as Array<{ pool_id: string; token: string; quote_asset: string; quote_decimals: number }>;
  const poolMap = new Map<string, { token: string; quote: string; dec: number }>();
  for (const p of existingPools) poolMap.set(p.pool_id.toLowerCase(), { token: p.token.toLowerCase(), quote: p.quote_asset.toLowerCase(), dec: Number(p.quote_decimals) });
  for (const r of poolRows) poolMap.set(r[0] as string, { token: r[1] as string, quote: r[2] as string, dec: r[3] as number });

  // Decimals for derived (non-exact) quote assets. WETH is 18; others read once.
  const quoteDecCache = new Map<string, number>();
  if (wethLc) quoteDecCache.set(wethLc, 18);
  const derivedQuotes = new Set<string>();
  for (const [, qas] of quoteAssetsByToken) for (const qa of qas) derivedQuotes.add(qa.toLowerCase());
  const needDec = [...derivedQuotes].filter((q) => !quoteDecCache.has(q));
  if (needDec.length > 0) {
    const decs = await erc20Field(client, needDec as Address[], "decimals");
    for (const q of needDec) quoteDecCache.set(q, Number(decs.get(q) ?? 18));
  }

  for (const t of knownTokens) {
    const factory = tokenFactory.get(t);
    const hook = factory ? hookForFactory(factory as Address) : undefined;
    const qas = quoteAssetsByToken.get(t) ?? (WETH_ADDRESS ? [WETH_ADDRESS] : []);
    for (const qa of qas) {
      const qaLc = qa.toLowerCase();
      const dec = quoteDecCache.get(qaLc) ?? 18;
      // When the factory's hook is known, probe exactly that pool (matches the
      // app's useTokenQuotePools); otherwise probe every candidate hook so an
      // unmapped factory still resolves rather than silently dropping its swaps.
      const ids = hook
        ? (() => { const k = poolKeyForToken(t as Address, qa, hook as Address); return k ? [poolId(k)] : []; })()
        : candidatePoolKeys(t as Address, qa).map((c) => c.id);
      for (const id of ids) {
        const pid = id.toLowerCase();
        if (!poolMap.has(pid)) poolMap.set(pid, { token: t, quote: qaLc, dec });
      }
    }
  }

  const ethUsd = await ethUsdNow(client);

  // 6b. SWAPS — the core fix. Query the singleton PoolManager FILTERED by each
  //    pool's indexed poolId (first topic) in SMALL block chunks, so every query
  //    returns a small, complete result set well under the RPC cap. The prior code
  //    queried ALL pools over wide ranges and silently lost nearly every swap.
  const swapLogsByPool = await mapLimit([...poolMap.keys()], DENSE_CONCURRENCY, (pid) =>
    getLogsChunked(client, {
      address: POOL_MANAGER_ADDRESS,
      abi: poolManagerAbi,
      eventName: "Swap",
      from: fromBlock,
      to: toBlock,
      args: { id: pid as Hex },
      span: DENSE_SPAN,
    }),
  );
  const swapLogs = swapLogsByPool.flat();

  // 7. Timestamps for every block that carries an event we store (incl. swaps).
  const tsBlocks = new Set<bigint>();
  for (const l of [...launchLogs, ...swapLogs, ...splitSched, ...splitApplied, ...splitInstant, ...parentBurned, ...buybackLogs]) {
    tsBlocks.add(l.blockNumber);
  }
  for (const l of poolSeededLogs) tsBlocks.add(l.blockNumber);
  const tsMap = await blockTimestamps(client, tsBlocks);
  const tsOf = (b: bigint): number => tsMap.get(b.toString()) ?? 0;

  // Backfill pool rows' + launch rows' ts now that timestamps are known.
  for (const r of poolRows) r.push(isoFromSec(tsOf(BigInt(r[5] as string))));
  for (const r of launchRows) r[6] = isoFromSec(tsOf(BigInt(r[5] as string)));

  // 8. Swaps — only those whose poolId is one of ours (all are, by construction).
  const swapRows: unknown[][] = [];
  const touchedSwapTokens = new Set<string>();
  let minSwapTs = Number.POSITIVE_INFINITY;
  let maxSwapTs = 0;
  for (const l of swapLogs) {
    const pid = (l.args.id as Hex)?.toLowerCase();
    const info = pid ? poolMap.get(pid) : undefined;
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
      pid,
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

  // 9. Split events + fee distributions (ParentBurned) + buyback runs.
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

  // 10. Transfers → balances (net deltas) + burns (to dead address). Per-token +
  //    small-chunk (same RPC-cap discipline as swaps), so a busy token's holder
  //    set is captured completely rather than silently truncated at the cap.
  const transferTokens = new Set<string>(knownTokens);
  for (const r of launchRows) transferTokens.add(r[0] as string);
  const { balanceRows, burnRows, touchedBurnDays } = await indexTransfers(
    client,
    sql,
    [...transferTokens] as Address[],
    fromBlock,
    toBlock,
    DENSE_SPAN,
  );

  // 11. Persist everything. Natural-key conflicts → DO NOTHING (idempotent).
  await bulkInsert(sql, "pools", ["pool_id", "token", "quote_asset", "quote_decimals", "open_tick", "block", "ts"], poolRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]]), "ON CONFLICT (pool_id) DO NOTHING");
  await bulkInsert(sql, "launches", ["token", "treasury", "creator", "factory", "launch_id", "launch_block", "launch_ts", "name", "symbol", "metadata_uri"], launchRows, "ON CONFLICT (token) DO NOTHING");
  await bulkInsert(sql, "swaps", ["pool_id", "token", "quote_asset", "side", "amount_token", "amount_quote", "price", "usd_size", "trader", "block_number", "block_ts", "tx_hash", "log_index"], swapRows, "ON CONFLICT (tx_hash, log_index) DO NOTHING");
  await bulkInsert(sql, "split_events", ["router", "token", "kind", "creator_bps", "treasury_bps", "buyback_bps", "parent_burn_bps", "rewards_bps", "effective_at", "block", "ts", "tx", "log_index"], splitRows, "ON CONFLICT (tx, log_index) DO NOTHING");
  await bulkInsert(sql, "fee_distributions", ["token", "router", "recipient", "amount", "kind", "block", "ts", "tx", "log_index"], feeRows, "ON CONFLICT (tx, log_index) DO NOTHING");
  await bulkInsert(sql, "buyback_runs", ["burner", "asset", "amount_in", "amount_burned", "total_burned", "block", "ts", "tx", "log_index"], buybackRows, "ON CONFLICT (tx, log_index) DO NOTHING");
  await bulkInsert(sql, "burns", ["token", "from_addr", "amount", "block", "ts", "tx", "log_index"], burnRows, "ON CONFLICT (tx, log_index) DO NOTHING");

  // Balances: upsert with increment (deltas may be negative).
  await upsertBalances(sql, balanceRows);

  // 12. Derived rollups: OHLC candles + daily rollups for touched tokens/days.
  if (swapRows.length > 0 && Number.isFinite(minSwapTs)) {
    await rollupOhlc(sql, [...touchedSwapTokens], minSwapTs, maxSwapTs);
  }
  await rollupDaily(sql, collectTouchedDays(swapRows, launchRows, touchedBurnDays));

  // 13. Advance the cursor.
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

/**
 * Quote assets per token, resolved the same way the app does (useTokenQuotePools):
 * call `quoteAssetsOf(token)` on the token's OWNING factory (multicall,
 * allowFailure). gen-4 factories implement it and return the full list (incl.
 * WETH); prior single-quote factories don't have it (the item fails) and could
 * only ever have graduated against WETH. WETH is always unioned in, so every token
 * at minimum gets its WETH pool even if the call fails.
 */
async function resolveQuoteAssets(
  client: Client,
  tokens: string[],
  tokenFactory: Map<string, string>,
): Promise<Map<string, Address[]>> {
  const out = new Map<string, Address[]>();
  if (tokens.length === 0) return out;
  const wethLc = WETH_ADDRESS?.toLowerCase();
  let res: Array<{ status: "success" | "failure"; result?: unknown }> = [];
  try {
    res = (await client.multicall({
      allowFailure: true,
      contracts: tokens.map((t) => ({
        address: (tokenFactory.get(t) ?? ZERO) as Address,
        abi: ballastFactoryAbi,
        functionName: "quoteAssetsOf" as const,
        args: [t as Address],
      })),
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  } catch {
    // Whole multicall failed → everyone falls back to WETH-only below.
    res = [];
  }
  tokens.forEach((t, i) => {
    const set = new Map<string, Address>();
    if (wethLc && WETH_ADDRESS) set.set(wethLc, WETH_ADDRESS);
    const r = res[i];
    if (r?.status === "success" && Array.isArray(r.result)) {
      for (const a of r.result as Address[]) {
        if (a) set.set(a.toLowerCase(), a);
      }
    }
    out.set(t, [...set.values()]);
  });
  return out;
}

async function indexTransfers(
  client: Client,
  sql: SqlClient,
  tokens: Address[],
  from: bigint,
  to: bigint,
  span: bigint,
): Promise<{ balanceRows: unknown[][]; burnRows: unknown[][]; touchedBurnDays: Set<string> }> {
  if (tokens.length === 0) return { balanceRows: [], burnRows: [], touchedBurnDays: new Set() };
  // Per-token + small span: a single token's Transfer stream is bounded per chunk,
  // so a busy token's holders are captured completely rather than silently cut off
  // at the RPC result cap (the same failure mode the per-pool swap fix addresses).
  const perToken = await mapLimit(tokens, DENSE_CONCURRENCY, (t) =>
    getLogsChunked(client, { address: t, abi: erc20Abi, eventName: "Transfer", from, to, span }),
  );
  const logs = perToken.flat();
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
