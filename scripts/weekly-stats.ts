/**
 * weekly-stats.ts — Section G: read-only weekly growth digest (chain 4663).
 *
 * Prints Markdown covering the last 7 days:
 *   1. New launches in the window, across the CURRENT + every HISTORICAL factory
 *      (web/lib/contracts.ts's FACTORY_ADDRESSES union — current factory first,
 *      then NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES in the order that env lists them,
 *      which is itself documented there as newest-first). We don't hand-roll a
 *      shorter list: every factory generation is read, exactly like Discover and
 *      web/lib/heroStats.ts do, via each factory's own `Launched` event.
 *   2. Per token (every launch in the union, not just this week's): swaps, volume
 *      in ETH, unique traders, holders, and pairs (quote assets) — all from the
 *      SAME sources the token page / Discover already use:
 *        - swaps/volume/traders: GeckoTerminal's per-pool trades endpoint, same
 *          two calls and same field mapping as web/lib/geckoServer.ts's
 *          resolveTopPool()/fetchPoolTrades() (duplicated here, not imported —
 *          this is a standalone root-level script outside the web/ Next.js
 *          project, the same reason web/scripts/inspectMainnet.ts and friends
 *          inline their own minimal ABIs instead of importing "@/lib/...").
 *        - holders: Blockscout's /api/v2/tokens/{address} `holders_count`, same
 *          field web/app/api/holders/route.ts reads.
 *        - pairs: BallastFactory.quoteAssetsOf(token) read live (falls back to
 *          [WETH] for a prior factory that predates the function, same fallback
 *          web/hooks/useProjects.ts uses).
 *      A metric with no source for a given token (pool not indexed yet, feed
 *      unset, Blockscout unreachable) prints "Unknown" — never a zero.
 *   3. Top 5 non-$BALLAST tokens by UNIQUE TRADERS (not price/mcap), excluding
 *      both V1_TOKEN_ADDRESS and BALLAST_V2_TOKEN_ADDRESS.
 *   4. A header: "as of block N / timestamp" from a live RPC read at run time.
 *
 * Read-only: no writes, no deploys, no broadcasts. Run (from repo root):
 *   npm install   (first time only — installs viem/tsx into the repo root)
 *   npx tsx scripts/weekly-stats.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, defineChain, parseAbiItem, type Address, type Log } from "viem";

// ── env loading (mirrors web/scripts/inspectMainnet.ts: web/.env.local first,
// then repo-root .env, first-defined-wins per key) ──────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(resolve(__dirname, "../web/.env.local"));
loadEnv(resolve(__dirname, "../.env"));

function asAddress(v: string | undefined): Address | undefined {
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  return v as Address;
}
function parseAddressList(v: string | undefined): Address[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => asAddress(s.trim()))
    .filter((a): a is Address => Boolean(a));
}

// ── Chain + addresses (same construction as web/lib/contracts.ts) ───────────
const RPC =
  process.env.RH_RPC_URL_PAID ||
  process.env.RPC_UPSTREAM_URL ||
  process.env.RH_MAINNET_RPC_URL ||
  "https://rpc.mainnet.chain.robinhood.com";

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const client = createPublicClient({ chain, transport: http(RPC) });

const FACTORY_ADDRESS = asAddress(process.env.NEXT_PUBLIC_FACTORY_ADDRESS);
const PRIOR_FACTORY_ADDRESSES = parseAddressList(process.env.NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES);
// Newest-first union, exactly like web/lib/contracts.ts's FACTORY_ADDRESSES —
// the current factory, then every prior generation.
const FACTORY_ADDRESSES: Address[] = [
  ...(FACTORY_ADDRESS ? [FACTORY_ADDRESS] : []),
  ...PRIOR_FACTORY_ADDRESSES,
];

const WETH_ADDRESS = asAddress(process.env.NEXT_PUBLIC_WETH_ADDRESS);
const ETH_USD_FEED_ADDRESS = asAddress(process.env.NEXT_PUBLIC_ETH_USD_FEED_ADDRESS);
const BLOCKSCOUT_URL = process.env.NEXT_PUBLIC_BLOCKSCOUT_URL || process.env.BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";

// $BALLAST v1 / v2 — fixed, excluded from the "top 5 by unique traders" ranking
// (web/lib/contracts.ts: V1_TOKEN_ADDRESS, BALLAST_V2_TOKEN_ADDRESS).
const V1_TOKEN_ADDRESS = "0x069a260370c61d91bd3e9842d81d378f9750f7f3".toLowerCase();
const BALLAST_V2_TOKEN_ADDRESS = "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C".toLowerCase();

// ── Minimal ABIs (same shapes as web/lib/abis.ts — trimmed to what this script
// reads) ──────────────────────────────────────────────────────────────────
const factoryAbi = [
  { type: "function", name: "launchCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "launches",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "token", type: "address" }, { name: "treasury", type: "address" }, { name: "creator", type: "address" }],
  },
  {
    type: "function",
    name: "quoteAssetsOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
] as const;

const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const aggregatorV3Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

const LAUNCHED_EVENT = parseAbiItem(
  "event Launched(uint256 indexed id, address indexed creator, address indexed token, address treasury, uint256 noticePeriod, string metadataURI)",
);

// ~7 days at this chain's ~100ms blocks — same approximation web/lib/heroStats.ts
// uses for "launches this week" (no indexer, chain-only).
const WEEK_BLOCKS = 6_048_000n;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

// ── GeckoTerminal (mirrors web/lib/geckoServer.ts's resolveTopPool /
// fetchPoolTrades — same endpoints, same field names, same direction-from-
// addresses normalization) ───────────────────────────────────────────────
const GT = "https://api.geckoterminal.com/api/v2";
const GT_NETWORK = "robinhood";
const GT_TIMEOUT_MS = 8_000;

type Trade = {
  kind: "buy" | "sell";
  ts: number;
  wallet: string;
  volumeUsd: number;
};

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), GT_TIMEOUT_MS);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

async function resolveTopPool(token: string): Promise<string | null> {
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(`${GT}/networks/${GT_NETWORK}/tokens/${token}/pools`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ attributes?: { address?: string } }> };
    return json.data?.[0]?.attributes?.address ?? null;
  } catch {
    return null;
  } finally {
    done();
  }
}

async function fetchPoolTrades(pool: string, token: string): Promise<Trade[]> {
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(`${GT}/networks/${GT_NETWORK}/pools/${pool}/trades`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) return [];
    type GtTrade = {
      attributes?: {
        block_timestamp?: string;
        tx_from_address?: string;
        from_token_address?: string;
        to_token_address?: string;
        volume_in_usd?: string;
      };
    };
    const json = (await res.json()) as { data?: GtTrade[] };
    const tok = token.toLowerCase();
    const out: Trade[] = [];
    for (const t of json.data ?? []) {
      const a = t.attributes;
      if (!a) continue;
      const to = (a.to_token_address ?? "").toLowerCase();
      const from = (a.from_token_address ?? "").toLowerCase();
      const isBuy = to === tok;
      const isSell = from === tok;
      if (!isBuy && !isSell) continue;
      out.push({
        kind: isBuy ? "buy" : "sell",
        ts: a.block_timestamp ? Math.floor(new Date(a.block_timestamp).getTime() / 1000) : 0,
        wallet: (a.tx_from_address ?? "").toLowerCase(),
        volumeUsd: num(a.volume_in_usd),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    done();
  }
}

// ── Blockscout holders (mirrors web/app/api/holders/route.ts's holders_count
// read) ───────────────────────────────────────────────────────────────────
async function fetchHoldersCount(token: Address): Promise<number | undefined> {
  try {
    const res = await fetch(`${BLOCKSCOUT_URL}/api/v2/tokens/${token}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return undefined; // includes Cloudflare bot-challenge 403s from non-browser clients
    const j = (await res.json()) as { holders_count?: string; holders?: string };
    const c = j.holders_count ?? j.holders;
    return c !== undefined ? Number(c) : undefined;
  } catch {
    return undefined;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────
function fmtNum(n: number | undefined): string {
  return n === undefined ? "Unknown" : n.toLocaleString("en");
}
function fmtEth(n: number | undefined): string {
  if (n === undefined) return "Unknown";
  if (n === 0) return "0";
  return n.toLocaleString("en", { maximumFractionDigits: 6, minimumFractionDigits: 0 });
}
function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function isoUtc(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

type LaunchRow = { token: Address; treasury: Address; creator: Address; factory: Address };

async function main() {
  if (FACTORY_ADDRESSES.length === 0) {
    console.error("No factory configured (NEXT_PUBLIC_FACTORY_ADDRESS unset) — nothing to report.");
    process.exitCode = 1;
    return;
  }

  // ── Header: live block + timestamp ───────────────────────────────────────
  const latestBlock = await client.getBlockNumber();
  const latestBlockData = await client.getBlock({ blockNumber: latestBlock });
  const nowTs = Number(latestBlockData.timestamp);
  const cutoffTs = nowTs - WEEK_SECONDS;
  const fromBlock = latestBlock > WEEK_BLOCKS ? latestBlock - WEEK_BLOCKS : 0n;

  // ── Enumerate every launch across the factory union, newest-factory-wins
  // dedupe (same precedence as web/hooks/useProjects.ts) ───────────────────
  const launchCounts = await Promise.all(
    FACTORY_ADDRESSES.map((f) =>
      client.readContract({ address: f, abi: factoryAbi, functionName: "launchCount" }).catch(() => 0n),
    ),
  );
  const seen = new Set<string>();
  const launchRows: LaunchRow[] = [];
  for (let fi = 0; fi < FACTORY_ADDRESSES.length; fi++) {
    const factory = FACTORY_ADDRESSES[fi]!;
    const count = Number(launchCounts[fi] ?? 0n);
    for (let i = 0; i < count; i++) {
      try {
        const [token, treasury, creator] = await client.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "launches",
          args: [BigInt(i)],
        });
        const key = token.toLowerCase();
        if (seen.has(key)) continue; // already seen from a newer factory
        seen.add(key);
        launchRows.push({ token, treasury, creator, factory });
      } catch {
        // unreadable row — skip, never fabricate
      }
    }
  }

  // ── New launches in the window: Launched events across every factory
  // (mirrors web/lib/heroStats.ts's launchesThisWeek scan) ─────────────────
  const launchedLogsPerFactory = await Promise.all(
    FACTORY_ADDRESSES.map((f) =>
      client
        .getLogs({ address: f, event: LAUNCHED_EVENT, fromBlock, toBlock: "latest" })
        .then((logs) => ({ factory: f, logs, ok: true as const }))
        .catch(() => ({ factory: f, logs: [] as Log[], ok: false as const })),
    ),
  );
  const anyLogScanFailed = launchedLogsPerFactory.some((r) => !r.ok);
  type NewLaunch = { factory: Address; token: Address; creator: Address; treasury: Address; blockNumber: bigint; ts?: number };
  const newLaunches: NewLaunch[] = [];
  for (const { factory, logs } of launchedLogsPerFactory) {
    for (const log of logs) {
      const args = (log as unknown as { args: { token: Address; creator: Address; treasury: Address } }).args;
      newLaunches.push({
        factory,
        token: args.token,
        creator: args.creator,
        treasury: args.treasury,
        blockNumber: log.blockNumber ?? 0n,
      });
    }
  }
  // Block timestamps for the new-launch rows (small set — fine to fetch per-block).
  await Promise.all(
    newLaunches.map(async (nl) => {
      try {
        const b = await client.getBlock({ blockNumber: nl.blockNumber });
        nl.ts = Number(b.timestamp);
      } catch {
        nl.ts = undefined;
      }
    }),
  );
  newLaunches.sort((a, b) => Number(b.blockNumber - a.blockNumber));

  // ── Per-token symbol, pairs, holders, GT activity ────────────────────────
  const symbolCache = new Map<string, string>();
  async function symbolOf(addr: Address): Promise<string> {
    const key = addr.toLowerCase();
    if (symbolCache.has(key)) return symbolCache.get(key)!;
    let sym: string;
    try {
      sym = await client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" });
    } catch {
      sym = shortAddr(addr);
    }
    symbolCache.set(key, sym);
    return sym;
  }

  type TokenStats = {
    token: Address;
    symbol: string;
    swaps?: number;
    volumeEth?: number;
    uniqueTraders?: number;
    holders?: number;
    pairs: string[];
  };

  // ETH/USD, live from the Chainlink feed (same read as web/hooks/useEthUsd.ts) —
  // needed to convert GeckoTerminal's USD-denominated trade volume into ETH.
  let ethUsd: number | undefined;
  if (ETH_USD_FEED_ADDRESS) {
    try {
      const [latestRoundData, decimals] = await Promise.all([
        client.readContract({ address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
        client.readContract({ address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "decimals" }),
      ]);
      const answer = latestRoundData[1];
      if (answer > 0n) ethUsd = Number(answer) / 10 ** decimals;
    } catch {
      ethUsd = undefined;
    }
  }

  const stats: TokenStats[] = [];
  for (const row of launchRows) {
    const symbol = await symbolOf(row.token);

    // Pairs — quoteAssetsOf(token) on the OWNING factory; fall back to [WETH]
    // for a prior factory that predates the function (same fallback as
    // web/hooks/useProjects.ts).
    let quoteAssets: Address[] = [];
    try {
      const result = await client.readContract({
        address: row.factory,
        abi: factoryAbi,
        functionName: "quoteAssetsOf",
        args: [row.token],
      });
      quoteAssets = [...result];
    } catch {
      quoteAssets = WETH_ADDRESS ? [WETH_ADDRESS] : [];
    }
    if (quoteAssets.length === 0 && WETH_ADDRESS) quoteAssets = [WETH_ADDRESS];
    const pairs = await Promise.all(quoteAssets.map((a) => symbolOf(a)));

    // Holders — Blockscout.
    const holders = await fetchHoldersCount(row.token);

    // Swaps / volume / unique traders — GeckoTerminal, last 7 days.
    const pool = await resolveTopPool(row.token);
    let swaps: number | undefined;
    let uniqueTraders: number | undefined;
    let volumeEth: number | undefined;
    if (pool) {
      const trades = await fetchPoolTrades(pool, row.token);
      const inWindow = trades.filter((t) => t.ts >= cutoffTs);
      swaps = inWindow.length;
      uniqueTraders = new Set(inWindow.map((t) => t.wallet).filter(Boolean)).size;
      const volumeUsd = inWindow.reduce((a, t) => a + t.volumeUsd, 0);
      volumeEth = ethUsd ? volumeUsd / ethUsd : undefined;
    }

    stats.push({ token: row.token, symbol, swaps, volumeEth, uniqueTraders, holders, pairs });
  }

  // ── Top 5 by unique traders, excluding $BALLAST v1/v2 ────────────────────
  const ranked = stats
    .filter((s) => s.token.toLowerCase() !== V1_TOKEN_ADDRESS.toLowerCase() && s.token.toLowerCase() !== BALLAST_V2_TOKEN_ADDRESS.toLowerCase())
    .filter((s) => s.uniqueTraders !== undefined)
    .sort((a, b) => (b.uniqueTraders ?? 0) - (a.uniqueTraders ?? 0))
    .slice(0, 5);

  // ── Render Markdown ───────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push("# BALLAST weekly stats");
  lines.push("");
  lines.push(`as of block ${latestBlock.toString()} / ${isoUtc(nowTs)}`);
  lines.push("");

  lines.push("## New launches (last 7 days)");
  lines.push("");
  if (anyLogScanFailed) {
    lines.push("_Launch-event scan failed for at least one factory — this list may be incomplete._");
    lines.push("");
  }
  if (newLaunches.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Token | Symbol | Creator | Factory | Launched |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const nl of newLaunches) {
      const sym = await symbolOf(nl.token);
      lines.push(
        `| ${nl.token} | ${sym} | ${nl.creator} | ${shortAddr(nl.factory)} | ${nl.ts !== undefined ? isoUtc(nl.ts) : "Unknown"} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Per-token activity (last 7 days)");
  lines.push("");
  lines.push("| Token | Symbol | Swaps | Volume (ETH) | Unique traders | Holders | Pairs |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of stats) {
    lines.push(
      `| ${s.token} | ${s.symbol} | ${fmtNum(s.swaps)} | ${fmtEth(s.volumeEth)} | ${fmtNum(s.uniqueTraders)} | ${fmtNum(s.holders)} | ${s.pairs.join(", ") || "Unknown"} |`,
    );
  }
  lines.push("");
  lines.push(
    "_Swaps/volume/unique traders come from GeckoTerminal's per-pool trades endpoint, the same source the token page uses — it returns a recent-trades window, not full 7-day pagination, so a heavily-traded pool's figures here are a lower bound, not a guaranteed total. \"Unknown\" means the metric has no source yet (pool not indexed, feed unset, or Blockscout unreachable from where this ran), never a zero._",
  );
  lines.push("");

  lines.push("## Top 5 by unique traders (excl. $BALLAST v1/v2)");
  lines.push("");
  if (ranked.length === 0) {
    lines.push("No tokens have a known unique-trader count this week.");
  } else {
    lines.push("| Rank | Token | Symbol | Unique traders |");
    lines.push("| --- | --- | --- | --- |");
    ranked.forEach((s, i) => {
      lines.push(`| ${i + 1} | ${s.token} | ${s.symbol} | ${fmtNum(s.uniqueTraders)} |`);
    });
    if (ranked.length < 5) {
      lines.push("");
      lines.push(`_Only ${ranked.length} token(s) had a known unique-trader count — the rest show "Unknown" and are excluded from ranking, not scored as zero._`);
    }
  }
  lines.push("");

  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error("weekly-stats failed:", e);
  process.exitCode = 1;
});
