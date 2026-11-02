// ─────────────────────────────────────────────────────────────────────────────
// Creator Fund — on-chain scanner orchestration (IO). Imported by the repo-root
// script scripts/creator-fund/scan.ts, which supplies the viem client + env.
//
// Pipeline per run (incremental — state carries what's already been scanned):
//   1. discover eligible launches on the current (gen-4+) factory, at/after start
//   2. per token: fetch NEW Swap + Transfer logs since its last-scanned block
//   3. price swaps, resolve trader EOAs, compute flags
//   4. build public + admin leaderboards (status, ranking, confirmed winners)
//
// All reads use relative imports only (no `@/`, no `server-only`) so this runs under
// plain `tsx` from the repo root as well as inside Next.
// ─────────────────────────────────────────────────────────────────────────────
import {
  createPublicClient,
  defineChain,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ASSET_REGISTRY_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  FACTORY_ADDRESS,
  POOL_MANAGER_ADDRESS,
  WETH_ADDRESS,
  hookForFactory,
  isHiddenToken,
  isRetiredToken,
} from "../contracts";
import { ballastFactoryAbi, erc20Abi, poolManagerAbi } from "../abis";
import { poolId, poolKeyForToken } from "../pool";
import {
  CAMPAIGN_START,
  computeStatus,
  isEligibleQuote,
  withinWindow,
  MILESTONE_WINDOW_SECONDS,
  type AdminLeaderboard,
  type AdminTokenEntry,
  type ConfirmedWinner,
  type PublicLeaderboard,
  type PublicTokenEntry,
  type QuoteAssetRef,
} from "../creatorFund";
import { resolveQuoteFeeds, feedPricesAtBlocks, type QuoteFeed } from "./pricing";
import { aggregateVolume, rawSwapFromDecoded, type DecodedSwap } from "./volume";
import { computeSwapFlags, type FlagContext, type RawSwap } from "./wash";
import { buildHolderExclusions } from "./exclusions";
import { computeHolders, type Transfer } from "./holders";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const launchedEvent = parseAbiItem(
  "event Launched(uint256 indexed id, address indexed creator, address indexed token, address treasury, uint256 noticePeriod, string metadataURI)",
);

// ── Persisted state shapes (JSON-safe; bigints as strings) ───────────────────
export type StoredSwap = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTs: number;
  trader: Address;
  side: "buy" | "sell";
  usd: number | null;
};
export type StoredTransfer = {
  from: Address;
  to: Address;
  value: string; // raw units
  blockNumber: number;
  blockTs: number;
  logIndex: number;
};
export type TokenState = {
  token: Address;
  name: string;
  symbol: string;
  creator: Address;
  treasury: Address;
  factory: Address;
  launchBlock: number;
  launchTs: number;
  quoteAssets: QuoteAssetRef[];
  pools: { poolId: Hex; quote: Address }[];
  lastScannedBlock: number;
  swaps: StoredSwap[];
  transfers: StoredTransfer[];
  /** Set once the whole 14-day window has been scanned — skip on later runs. */
  finalized?: boolean;
};
export type ScanState = {
  campaignStart: number;
  discoveryLastBlock: number;
  tokens: Record<string, TokenState>; // keyed by lowercased token address
};

export function emptyState(): ScanState {
  return { campaignStart: CAMPAIGN_START, discoveryLastBlock: 0, tokens: {} };
}

/**
 * Build the read-only viem client for chain 4663 from an RPC URL. Lives here (in
 * web/lib) so the repo-root script never imports `viem` directly — Node resolves
 * bare specifiers from the importing file's location, and the repo root has no
 * `viem` in node_modules, only `web/` does.
 */
export function makeClient(rpcUrl: string): PublicClient {
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  return createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
}

// ── small concurrency + chunking helpers ─────────────────────────────────────
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

const DEFAULT_SPAN = BigInt(process.env.CREATOR_FUND_CHUNK ?? "500000");

/**
 * getLogs across [from,to] in spans, halving the span on an RPC "too many results"
 * error so one run adapts to whatever the endpoint allows. Returns logs in order.
 */
async function getLogsChunked(
  client: PublicClient,
  params: Record<string, unknown>,
  from: bigint,
  to: bigint,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let span = DEFAULT_SPAN;
  let start = from;
  while (start <= to) {
    const end = start + span - 1n > to ? to : start + span - 1n;
    try {
      const logs = (await client.getLogs({
        ...params,
        fromBlock: start,
        toBlock: end,
      } as never)) as unknown[];
      out.push(...logs);
      start = end + 1n;
    } catch (e) {
      if (span > 2_000n) {
        span = span / 2n; // back off and retry the same start
        continue;
      }
      throw e;
    }
  }
  return out;
}

/** Block timestamps (unix secs) for a set of block numbers, deduped. */
async function blockTimestamps(client: PublicClient, blocks: number[]): Promise<Map<number, number>> {
  const uniq = Array.from(new Set(blocks));
  const res = await mapLimit(uniq, 10, async (b) => {
    const blk = await client.getBlock({ blockNumber: BigInt(b) });
    return [b, Number(blk.timestamp)] as const;
  });
  return new Map(res);
}

/** Resolve the real trader EOA (tx.from) per unique tx hash, with a cache. */
async function resolveTraders(
  client: PublicClient,
  txHashes: string[],
  cache: Map<string, Address>,
): Promise<void> {
  const missing = Array.from(new Set(txHashes)).filter((h) => !cache.has(h));
  await mapLimit(missing, 8, async (h) => {
    try {
      const tx = await client.getTransaction({ hash: h as Hex });
      cache.set(h, tx.from as Address);
    } catch {
      /* leave unresolved; caller falls back to event sender */
    }
  });
}

// ── 1. discovery ─────────────────────────────────────────────────────────────
/**
 * Find launches on the current (gen-4+) factory at/after the campaign start that
 * have ≥1 eligible stock quote asset and aren't hidden/retired. Adds/updates their
 * TokenState skeletons in `state` (pools, metadata), never touching swaps/transfers.
 */
export async function discoverEligibleLaunches(
  client: PublicClient,
  state: ScanState,
  latest: bigint,
): Promise<string[]> {
  if (!FACTORY_ADDRESS || CAMPAIGN_START <= 0) return [];
  // Capture in a local so narrowing survives across `await` (an imported binding is
  // re-widened to `Address | undefined` after each await by TS).
  const factory: Address = FACTORY_ADDRESS;
  const hook = hookForFactory(factory);
  if (!hook) return [];

  const fromBlock = BigInt(Math.max(0, state.discoveryLastBlock));
  const rawLogs = (await getLogsChunked(
    client,
    { address: factory, event: launchedEvent },
    fromBlock,
    latest,
  )) as { args: { token: Address; creator: Address; treasury: Address }; blockNumber: bigint }[];

  // Timestamp every launch block.
  const tsMap = await blockTimestamps(client, rawLogs.map((l) => Number(l.blockNumber)));

  // Candidate tokens (dedup; newest wins) that are at/after start and not hidden/retired.
  const candidates = rawLogs
    .map((l) => ({
      token: l.args.token,
      creator: l.args.creator,
      treasury: l.args.treasury,
      launchBlock: Number(l.blockNumber),
      launchTs: tsMap.get(Number(l.blockNumber)) ?? 0,
    }))
    .filter((c) => c.launchTs >= CAMPAIGN_START && !isHiddenToken(c.token) && !isRetiredToken(c.token));

  if (candidates.length === 0) {
    state.discoveryLastBlock = Number(latest);
    return [];
  }

  // Quote assets per token (gen-4 factory has quoteAssetsOf).
  const quoteRes = await client.multicall({
    allowFailure: true,
    contracts: candidates.map((c) => ({
      address: factory,
      abi: ballastFactoryAbi,
      functionName: "quoteAssetsOf" as const,
      args: [c.token],
    })),
  });
  // Token name/symbol.
  const [names, symbols] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: candidates.map((c) => ({ address: c.token, abi: erc20Abi, functionName: "name" as const })),
    }),
    client.multicall({
      allowFailure: true,
      contracts: candidates.map((c) => ({ address: c.token, abi: erc20Abi, functionName: "symbol" as const })),
    }),
  ]);

  // Symbols of each quote asset (for display).
  const allQuotes = new Set<string>();
  const perTokenQuotes: Address[][] = candidates.map((_, i) => {
    const r = quoteRes[i];
    const qs = r && r.status === "success" ? (r.result as Address[]) : [];
    qs.forEach((q) => allQuotes.add(q.toLowerCase()));
    return qs;
  });
  const quoteList = Array.from(allQuotes) as Address[];
  const quoteSymRes = quoteList.length
    ? await client.multicall({
        allowFailure: true,
        contracts: quoteList.map((q) => ({ address: q, abi: erc20Abi, functionName: "symbol" as const })),
      })
    : [];
  const quoteSym = new Map<string, string>();
  quoteList.forEach((q, i) => {
    const r = quoteSymRes[i];
    quoteSym.set(q.toLowerCase(), r && r.status === "success" ? (r.result as string) : "?");
  });

  const eligibleTokens: string[] = [];
  candidates.forEach((c, i) => {
    const qs = perTokenQuotes[i] ?? [];
    const hasEligible = qs.some((q) => isEligibleQuote(q));
    if (!hasEligible) return; // WETH-only or non-stock-quote → not eligible

    const quoteAssets: QuoteAssetRef[] = qs.map((q) => ({
      address: q,
      symbol: quoteSym.get(q.toLowerCase()) ?? "?",
      eligible: isEligibleQuote(q),
    }));
    const pools = qs.map((q) => {
      const key = poolKeyForToken(c.token, q, hook);
      return { poolId: key ? poolId(key) : ("0x" as Hex), quote: q };
    });

    const key = c.token.toLowerCase();
    const prior = state.tokens[key];
    state.tokens[key] = {
      token: c.token,
      name: (names[i]?.status === "success" ? (names[i]!.result as string) : prior?.name) ?? "",
      symbol: (symbols[i]?.status === "success" ? (symbols[i]!.result as string) : prior?.symbol) ?? "",
      creator: c.creator,
      treasury: c.treasury,
      factory,
      launchBlock: c.launchBlock,
      launchTs: c.launchTs,
      quoteAssets,
      pools,
      lastScannedBlock: prior?.lastScannedBlock ?? c.launchBlock - 1,
      swaps: prior?.swaps ?? [],
      transfers: prior?.transfers ?? [],
    };
    eligibleTokens.push(key);
  });

  state.discoveryLastBlock = Number(latest);
  return eligibleTokens;
}

// ── 2. per-token incremental scan ────────────────────────────────────────────
/**
 * Fetch NEW Swap + Transfer logs for a token since its lastScannedBlock (bounded by
 * `toBlock` and the token's 14-day window), price swaps, resolve traders, and append
 * to its state. Returns the number of new swaps + transfers.
 */
export async function scanTokenWindow(
  client: PublicClient,
  ts: TokenState,
  toBlock: bigint,
  deps: { registry: Address; weth: Address; ethUsdFeed: Address; traderCache: Map<string, Address> },
): Promise<{ newSwaps: number; newTransfers: number }> {
  const windowEndTs = ts.launchTs + MILESTONE_WINDOW_SECONDS;
  const from = BigInt(ts.lastScannedBlock + 1);
  if (from > toBlock) return { newSwaps: 0, newTransfers: 0 };

  // Swaps across all pools.
  const swapLogsPerPool = await mapLimit(ts.pools, 4, async (p) => {
    if (p.poolId === "0x") return [] as never[];
    return (await getLogsChunked(
      client,
      { address: POOL_MANAGER_ADDRESS, event: poolManagerAbi[0], args: { id: p.poolId } },
      from,
      toBlock,
    )) as {
      transactionHash: Hex;
      logIndex: number;
      blockNumber: bigint;
      args: { sender: Address; amount0: bigint; amount1: bigint };
    }[];
  });
  const swapLogs = swapLogsPerPool.flatMap((logs, i) => logs.map((l) => ({ ...l, quote: ts.pools[i]!.quote })));

  // Transfers of the launched token.
  const transferLogs = (await getLogsChunked(
    client,
    { address: ts.token, event: transferEvent },
    from,
    toBlock,
  )) as { transactionHash: Hex; logIndex: number; blockNumber: bigint; args: { from: Address; to: Address; value: bigint } }[];

  // Timestamps for all touched blocks.
  const blocks = [
    ...swapLogs.map((l) => Number(l.blockNumber)),
    ...transferLogs.map((l) => Number(l.blockNumber)),
  ];
  const tsMap = await blockTimestamps(client, blocks);

  // Resolve trader EOAs for swaps.
  await resolveTraders(client, swapLogs.map((l) => l.transactionHash), deps.traderCache);

  // Price swaps: one feed per quote, prices at each swap block.
  const quotes = Array.from(new Set(ts.pools.map((p) => p.quote.toLowerCase()))) as Address[];
  const feeds = await resolveQuoteFeeds(client, quotes, {
    registry: deps.registry,
    weth: deps.weth,
    ethUsdFeed: deps.ethUsdFeed,
  });
  const priceNeeds = swapLogs
    .map((l) => {
      const f = feeds.get(l.quote.toLowerCase());
      return f ? { feed: f.feed, feedDecimals: f.feedDecimals, block: Number(l.blockNumber) } : null;
    })
    .filter((x): x is { feed: Address; feedDecimals: number; block: number } => x !== null);
  const prices = await feedPricesAtBlocks(client, priceNeeds);

  // Build + append stored swaps (skip out-of-window).
  let newSwaps = 0;
  for (const l of swapLogs) {
    const blockTs = tsMap.get(Number(l.blockNumber)) ?? 0;
    if (!withinWindow(ts.launchTs, blockTs)) continue;
    const feed = feeds.get(l.quote.toLowerCase());
    const price = feed ? prices.get(`${feed.feed.toLowerCase()}|${Number(l.blockNumber)}`) : undefined;
    const decoded: DecodedSwap = {
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      blockNumber: Number(l.blockNumber),
      blockTs,
      trader: deps.traderCache.get(l.transactionHash) ?? l.args.sender,
      token: ts.token,
      quote: l.quote,
      amount0: l.args.amount0,
      amount1: l.args.amount1,
    };
    const raw = rawSwapFromDecoded(decoded, feed, price);
    ts.swaps.push({
      txHash: raw.txHash,
      logIndex: raw.logIndex,
      blockNumber: raw.blockNumber,
      blockTs: raw.blockTs,
      trader: raw.trader,
      side: raw.side,
      usd: raw.usd,
    });
    newSwaps++;
  }

  // Build + append stored transfers (keep in-window only; that's all the holder
  // milestone needs, and it bounds state size).
  let newTransfers = 0;
  for (const l of transferLogs) {
    const blockTs = tsMap.get(Number(l.blockNumber)) ?? 0;
    if (blockTs > windowEndTs) continue; // keep pre-window (mint/seed) + in-window
    ts.transfers.push({
      from: l.args.from,
      to: l.args.to,
      value: l.args.value.toString(),
      blockNumber: Number(l.blockNumber),
      blockTs,
      logIndex: l.logIndex,
    });
    newTransfers++;
  }

  ts.lastScannedBlock = Number(toBlock);
  return { newSwaps, newTransfers };
}

// ── 3. leaderboard assembly ──────────────────────────────────────────────────
function toRawSwaps(ts: TokenState): RawSwap[] {
  return ts.swaps.map((s) => ({
    txHash: s.txHash,
    logIndex: s.logIndex,
    blockNumber: s.blockNumber,
    blockTs: s.blockTs,
    trader: s.trader,
    side: s.side,
    usd: s.usd,
  }));
}
function toTransfers(ts: TokenState): Transfer[] {
  return ts.transfers.map((t) => ({
    from: t.from,
    to: t.to,
    value: BigInt(t.value),
    blockNumber: t.blockNumber,
    blockTs: t.blockTs,
    logIndex: t.logIndex,
  }));
}

/** Wallets that received the token directly from the creator within the window —
 *  our (log-only) proxy for "funded by the creator" (native-ETH funding isn't
 *  traced; documented limitation). */
function creatorFundedWallets(ts: TokenState): Set<string> {
  const creator = ts.creator.toLowerCase();
  const out = new Set<string>();
  for (const t of ts.transfers) {
    if (t.from.toLowerCase() === creator && BigInt(t.value) > 0n && withinWindow(ts.launchTs, t.blockTs)) {
      out.add(t.to.toLowerCase());
    }
  }
  return out;
}

/**
 * Build the public + admin leaderboards from state. Pure given `now` + confirmed
 * winners (no IO), so it's deterministic and testable.
 */
export function buildLeaderboards(
  state: ScanState,
  now: number,
  confirmed: ConfirmedWinner[],
  lastScannedBlock: number,
): { public: PublicLeaderboard; admin: AdminLeaderboard } {
  const confirmedByToken = new Map(confirmed.map((c) => [c.token.toLowerCase(), c] as const));

  type Interim = {
    entry: AdminTokenEntry;
    creator: string;
    volMile: number | null;
    holdMile: number | null;
    volExcl: number;
    holders: number;
  };

  const interim: Interim[] = [];

  for (const key of Object.keys(state.tokens)) {
    const ts = state.tokens[key]!;
    const teamRecipients = new Set<string>(); // best-effort: resolved elsewhere if available
    const exclude = buildHolderExclusions({
      creator: ts.creator,
      treasury: ts.treasury,
      teamRecipients: [],
    });

    const flagCtx: FlagContext = {
      creator: ts.creator,
      treasury: ts.treasury,
      teamRecipients,
      creatorFundedWallets: creatorFundedWallets(ts),
    };
    const raw = toRawSwaps(ts);
    const { flaggedSwaps, flaggedKeys } = computeSwapFlags(raw, flagCtx);
    const vol = aggregateVolume(raw, ts.launchTs, flaggedKeys);
    const hold = computeHolders(toTransfers(ts), exclude, ts.launchTs);

    const entry: AdminTokenEntry = {
      token: ts.token,
      name: ts.name,
      symbol: ts.symbol,
      creator: ts.creator,
      treasury: ts.treasury,
      factory: ts.factory,
      quoteAssets: ts.quoteAssets,
      launchBlock: ts.launchBlock,
      launchTs: ts.launchTs,
      windowEndTs: ts.launchTs + MILESTONE_WINDOW_SECONDS,
      rawVolumeUsd: vol.rawVolumeUsd,
      flaggedVolumeUsd: vol.flaggedVolumeUsd,
      volumeExcludingFlaggedUsd: vol.volumeExcludingFlaggedUsd,
      holders: hold.holders,
      volumeMilestoneReachedTs: vol.volumeMilestoneReachedTs,
      holdersMilestoneReachedTs: hold.holdersMilestoneReachedTs,
      secondMilestoneReachedTs: null,
      status: "in_progress",
      rank: null,
      reviewNotes: vol.unpricedCount > 0 ? [`${vol.unpricedCount} unpriced swap(s) excluded from USD`] : [],
      funded: confirmedByToken.get(key)?.funded ?? null,
      flaggedSwaps,
      flaggedHolders: hold.flaggedHolders,
    };

    interim.push({
      entry,
      creator: ts.creator.toLowerCase(),
      volMile: vol.volumeMilestoneReachedTs,
      holdMile: hold.holdersMilestoneReachedTs,
      volExcl: vol.volumeExcludingFlaggedUsd,
      holders: hold.holders,
    });
  }

  // First pass: find, per creator, the earliest second-milestone time among tokens
  // that reached both (for the one-entry-per-creator rule).
  const earliestByCreator = new Map<string, number>();
  for (const it of interim) {
    if (it.volMile !== null && it.holdMile !== null) {
      const second = Math.max(it.volMile, it.holdMile);
      const prev = earliestByCreator.get(it.creator);
      if (prev === undefined || second < prev) earliestByCreator.set(it.creator, second);
    }
  }

  // Second pass: status.
  for (const it of interim) {
    const bothReached = it.volMile !== null && it.holdMile !== null;
    const second = bothReached ? Math.max(it.volMile!, it.holdMile!) : null;
    const creatorEarliest = earliestByCreator.get(it.creator);
    const creatorHasEarlierQualifier =
      bothReached && creatorEarliest !== undefined && second !== null && creatorEarliest < second;

    const { status, secondMilestoneReachedTs, reviewNotes } = computeStatus({
      now,
      launchTs: it.entry.launchTs,
      volumeMilestoneReachedTs: it.volMile,
      holdersMilestoneReachedTs: it.holdMile,
      volumeExcludingFlaggedUsd: it.volExcl,
      holders: it.holders,
      creatorHasEarlierQualifier,
    });
    it.entry.status = status;
    it.entry.secondMilestoneReachedTs = secondMilestoneReachedTs;
    it.entry.reviewNotes = [...it.entry.reviewNotes, ...reviewNotes];
  }

  // Rank the clean qualifiers by second-milestone time; first MAX from creatorFund.
  const qualified = interim
    .filter((it) => it.entry.status === "qualified" && it.entry.secondMilestoneReachedTs !== null)
    .sort((a, b) => a.entry.secondMilestoneReachedTs! - b.entry.secondMilestoneReachedTs!);
  qualified.forEach((it, i) => {
    it.entry.rank = i + 1; // 1-based; the page caps display at MAX_WINNERS
  });

  // Sort the whole board for display: qualified by rank, then in_progress by
  // progress, then review, then expired; newest launch breaks ties.
  const order: Record<string, number> = { qualified: 0, in_progress: 1, disqualified_candidate: 2, expired: 3 };
  const admins = interim.map((it) => it.entry).sort((a, b) => {
    const s = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (s !== 0) return s;
    if (a.status === "qualified" && b.status === "qualified") return (a.rank ?? 99) - (b.rank ?? 99);
    return b.launchTs - a.launchTs;
  });

  const meta = { generatedAt: now, campaignStart: state.campaignStart, lastScannedBlock };
  const publicTokens: PublicTokenEntry[] = admins.map((a) => {
    // Strip admin-only flag detail for the public board.
    const { flaggedSwaps: _fs, flaggedHolders: _fh, ...pub } = a;
    void _fs;
    void _fh;
    return pub;
  });

  return {
    public: { meta, tokens: publicTokens },
    admin: { meta, tokens: admins },
  };
}

export const DEPS = { ASSET_REGISTRY_ADDRESS, ETH_USD_FEED_ADDRESS, WETH_ADDRESS };
export type { QuoteFeed };
