import { NextResponse } from "next/server";
import { getAbiItem, type Address, type Hex } from "viem";
import { serverClient } from "@/lib/serverChain";
import {
  ballastFactoryAbi,
  poolManagerAbi,
  feeRouterV2Abi,
  feeRouterFactoryAbi,
  projectTreasuryAbi,
  ballastTokenAbi,
  erc20Abi,
} from "@/lib/abis";
import { basketZapAbi } from "@/lib/basketZapAbi";
import { decodeEventLog } from "viem";
import {
  FACTORY_ADDRESSES,
  POOL_MANAGER_ADDRESS,
  BUYBACK_V2_ADDRESS,
  BASKET_ZAP_ADDRESS,
  BALLAST_V2_TOKEN_ADDRESS,
  WETH_ADDRESS,
  LENS_ADDRESS,
  isHiddenToken,
} from "@/lib/contracts";
import { backingLensAbi } from "@/lib/abis";
import { TG, botConfigured, MAX_BLOCKS_PER_RUN, MAX_MESSAGES_PER_RUN, KV_CURSOR_KEY, KV_POOLMAP_KEY } from "@/lib/tg/config";
import { KV_CONFIGURED, kvGet, kvSet, kvSetDedup, kvHGetAll, kvHSet } from "@/lib/tg/kv";
import { decodeTgLog, buybackBurnedAbi, type TgEventWithMeta } from "@/lib/tg/decode";
import { sendMessage } from "@/lib/tg/telegram";
import * as fmt from "@/lib/tg/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authed(req: Request): boolean {
  if (!TG.cronSecret) return false;
  const h = req.headers;
  const bearer = h.get("authorization");
  if (bearer && bearer === `Bearer ${TG.cronSecret}`) return true;
  return h.get("x-cron-secret") === TG.cronSecret;
}

// This chain's public RPC caps eth_getLogs at 10,000,000 blocks per request, so a
// wide range (notably the first-run pool-map seed over 0..tip, ~95M blocks) must be
// split or the single call throws and silently returns nothing (empty pool map ->
// no buy/sell alerts ever). Regular per-run windows are <= MAX_BLOCKS_PER_RUN and
// take the fast single-call path. Each chunk is independently try/caught so one
// transient failure doesn't drop the rest.
const GETLOGS_MAX_SPAN = 9_000_000n; // safely under the 10M RPC limit

async function getLogsFor(client: ReturnType<typeof serverClient>, params: { address?: Address; abi: readonly unknown[]; eventName: string; from: bigint; to: bigint }): Promise<TgEventWithMeta[]> {
  const event = getAbiItem({ abi: params.abi as never, name: params.eventName as never });
  const out: TgEventWithMeta[] = [];
  for (let lo = params.from; lo <= params.to; lo += GETLOGS_MAX_SPAN) {
    const hi = lo + GETLOGS_MAX_SPAN - 1n > params.to ? params.to : lo + GETLOGS_MAX_SPAN - 1n;
    try {
      const logs = (await client.getLogs({ address: params.address, event: event as never, fromBlock: lo, toBlock: hi })) as Array<{ transactionHash?: Hex | null; logIndex?: number | null; address?: Address; topics: [Hex, ...Hex[]]; data: Hex }>;
      for (const log of logs) {
        const ev = decodeTgLog(log);
        if (ev) out.push({ ...ev, txHash: log.transactionHash ?? undefined, logIndex: log.logIndex ?? undefined, address: log.address as Address });
      }
    } catch {
      // skip this chunk; best-effort (pool-map seed and per-run reads both tolerate it)
    }
  }
  return out;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!TG.enabled) return NextResponse.json({ skipped: "TG_BOT_ENABLED is off" });
  if (!TG.dryRun && !botConfigured()) return NextResponse.json({ skipped: "bot not configured (token/chat)" });
  if (!KV_CONFIGURED) return NextResponse.json({ skipped: "KV not configured (cursor/dedup required)" });
  if (!POOL_MANAGER_ADDRESS || FACTORY_ADDRESSES.length === 0) return NextResponse.json({ skipped: "chain addresses not configured" });

  const client = serverClient();
  const latest = await client.getBlockNumber();

  // First run ever: seed the pool map (reads only) and set the cursor at the tip.
  // NEVER backfill history into the channel.
  const cursorRaw = await kvGet(KV_CURSOR_KEY);
  if (cursorRaw === null) {
    await seedPoolMap(client, 0n, latest);
    await kvSet(KV_CURSOR_KEY, latest.toString());
    return NextResponse.json({ firstRun: true, cursor: latest.toString() });
  }

  const from = BigInt(cursorRaw) + 1n;
  if (from > latest) return NextResponse.json({ upToDate: true, cursor: cursorRaw });
  const to = from + MAX_BLOCKS_PER_RUN - 1n > latest ? latest : from + MAX_BLOCKS_PER_RUN - 1n;

  // Keep the pool map current for swap resolution.
  await seedPoolMap(client, from, to);
  const poolMap = await kvHGetAll(KV_POOLMAP_KEY);

  // Fetch each category. Split/parentBurn/treasury queries carry no address — the
  // event signatures are unique to our contracts, so this safely scopes to ours.
  const [launches, swaps, buybacks, burns, splitsSched, splitsApplied1, splitsApplied2, parentBurns, depCreator, depAccepted, baskets] = await Promise.all([
    Promise.all(FACTORY_ADDRESSES.map((f) => getLogsFor(client, { address: f, abi: ballastFactoryAbi, eventName: "Launched", from, to }))).then((a) => a.flat()),
    getLogsFor(client, { address: POOL_MANAGER_ADDRESS, abi: poolManagerAbi, eventName: "Swap", from, to }),
    BUYBACK_V2_ADDRESS ? getLogsFor(client, { address: BUYBACK_V2_ADDRESS, abi: buybackBurnedAbi, eventName: "BuybackBurned", from, to }) : Promise.resolve([]),
    getLogsFor(client, { address: BALLAST_V2_TOKEN_ADDRESS, abi: ballastTokenAbi, eventName: "Transfer", from, to }),
    getLogsFor(client, { abi: feeRouterV2Abi, eventName: "SplitScheduled", from, to }),
    getLogsFor(client, { abi: feeRouterV2Abi, eventName: "SplitApplied", from, to }),
    getLogsFor(client, { abi: feeRouterV2Abi, eventName: "SplitAppliedInstant", from, to }),
    getLogsFor(client, { abi: feeRouterV2Abi, eventName: "ParentBurned", from, to }),
    getLogsFor(client, { abi: projectTreasuryAbi, eventName: "CreatorDeposited", from, to }),
    getLogsFor(client, { abi: projectTreasuryAbi, eventName: "DepositAccepted", from, to }),
    BASKET_ZAP_ADDRESS ? getLogsFor(client, { address: BASKET_ZAP_ADDRESS, abi: basketZapAbi, eventName: "BasketSwapped", from, to }) : Promise.resolve([]),
  ]);

  const all: TgEventWithMeta[] = [
    ...launches, ...swaps, ...buybacks,
    ...burns.filter((e) => e.kind === "deadTransfer"),
    ...splitsSched, ...splitsApplied1, ...splitsApplied2, ...parentBurns, ...depCreator, ...depAccepted, ...baskets,
  ];

  // Resolve symbols for every token we might print (bounded by events in range).
  const tokenAddrs = new Set<string>();
  for (const e of all) {
    if (e.kind === "launch") tokenAddrs.add(e.token);
    if (e.kind === "splitScheduled" || e.kind === "splitApplied") { /* resolved via router.token() below */ }
    if (e.kind === "basketFill") tokenAddrs.add(e.launchToken);
    if (e.kind === "swap") { const m = poolMap[e.poolId.toLowerCase()]; if (m) tokenAddrs.add(m.split("|")[0]!); }
  }
  // Resolve router -> token for split events.
  const routerSet = new Set(all.filter((e) => e.kind === "splitScheduled" || e.kind === "splitApplied").map((e) => (e as { router: Address }).router));
  const routerToken = await resolveRouterTokens(client, [...routerSet]);
  for (const t of Object.values(routerToken)) tokenAddrs.add(t);
  const treasuryToken = await resolveTreasuryTokens(client, all.filter((e) => e.kind === "treasuryDeposit").map((e) => (e as { treasury: Address }).treasury));
  for (const t of Object.values(treasuryToken)) tokenAddrs.add(t);
  // Per-launch details: quote-asset pairs + split + parent, from the launch tx.
  const launchDetails = await resolveLaunchDetails(client, launches, poolMap);
  for (const d of Object.values(launchDetails)) { d.pairAddrs.forEach((a) => tokenAddrs.add(a)); if (d.parent) tokenAddrs.add(d.parent); }

  const symbols = await resolveSymbols(client, [...tokenAddrs]);
  const sym = (a?: string) => (a ? symbols[a.toLowerCase()] : undefined);

  // Build messages in chronological order, applying thresholds + dedup.
  const minSwapWei = BigInt(Math.round(TG.minSwapEth * 1e18));
  const minBurnWei = BigInt(Math.round(TG.minBurn)) * 10n ** 18n;
  const built: string[] = [];
  const counts: Record<string, number> = {};

  for (const e of all) {
    if (!e.txHash || e.logIndex === undefined) continue;
    // Never post activity for a hidden (test/smoke) token — the same canonical
    // hide list the app uses (web/lib/hiddenTokens.ts, re-exported from contracts).
    const hideTok = tokenForHiding(e, poolMap, routerToken, treasuryToken);
    if (hideTok && isHiddenToken(hideTok)) continue;
    const dedupKey = `tg:seen:${e.txHash}:${e.logIndex}`;
    const msg = await buildMessage(e, { poolMap, sym, routerToken, treasuryToken, launchDetails, minSwapWei, minBurnWei });
    if (!msg) continue;
    // Only consume a dedup slot once we actually have a postable message.
    const fresh = await kvSetDedup(dedupKey).catch(() => true);
    if (!fresh) continue;
    built.push(msg);
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }

  // Send, collapsing overflow into a single digest.
  let sent = 0;
  const toSend = built.length <= MAX_MESSAGES_PER_RUN ? built : [...built.slice(0, MAX_MESSAGES_PER_RUN - 1), fmt.msgDigest(built.length - (MAX_MESSAGES_PER_RUN - 1), counts)];
  for (const m of toSend) {
    try { const r = await sendMessage(m); if (r.sent || r.dryRun) sent++; } catch (err) { console.error("[tg] send failed", (err as Error).message); }
  }

  await kvSet(KV_CURSOR_KEY, to.toString());
  return NextResponse.json({ from: from.toString(), to: to.toString(), decoded: all.length, posted: sent, counts, dryRun: TG.dryRun });
}

// ── helpers ──

async function seedPoolMap(client: ReturnType<typeof serverClient>, from: bigint, to: bigint) {
  // PoolSeeded(token, quoteAsset, poolId,…) → poolId -> "token|quoteAsset".
  const seeded = (await Promise.all(FACTORY_ADDRESSES.map((f) => getLogsFor(client, { address: f, abi: ballastFactoryAbi, eventName: "PoolSeeded", from, to })))).flat();
  for (const e of seeded) {
    if (e.kind !== "poolSeeded") continue;
    await kvHSet(KV_POOLMAP_KEY, e.poolId.toLowerCase(), `${e.token}|${e.quoteAsset}`).catch(() => {});
  }
}

async function resolveSymbols(client: ReturnType<typeof serverClient>, addrs: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(addrs.map((a) => a.toLowerCase()))].filter(Boolean) as Address[];
  if (unique.length === 0) return {};
  const res = await client.multicall({ contracts: unique.map((address) => ({ address, abi: erc20Abi, functionName: "symbol" as const })), allowFailure: true });
  const out: Record<string, string> = {};
  unique.forEach((a, i) => { const r = res[i]; if (r?.status === "success") out[a] = String(r.result); });
  return out;
}

async function resolveRouterTokens(client: ReturnType<typeof serverClient>, routers: Address[]): Promise<Record<string, Address>> {
  if (routers.length === 0) return {};
  const res = await client.multicall({ contracts: routers.map((address) => ({ address, abi: feeRouterV2Abi, functionName: "token" as const })), allowFailure: true });
  const out: Record<string, Address> = {};
  routers.forEach((r, i) => { const x = res[i]; if (x?.status === "success") out[r.toLowerCase()] = x.result as Address; });
  return out;
}

async function resolveTreasuryTokens(client: ReturnType<typeof serverClient>, treasuries: Address[]): Promise<Record<string, Address>> {
  const unique = [...new Set(treasuries.map((t) => t.toLowerCase()))] as Address[];
  if (unique.length === 0) return {};
  const res = await client.multicall({ contracts: unique.map((address) => ({ address, abi: projectTreasuryAbi, functionName: "projectToken" as const })), allowFailure: true });
  const out: Record<string, Address> = {};
  unique.forEach((t, i) => { const x = res[i]; if (x?.status === "success") out[t] = x.result as Address; });
  return out;
}

type Split = { creatorBps: number; treasuryBps: number; buybackBps: number; parentBurnBps: number; rewardsBps: number };
type LaunchDetail = { pairAddrs: Address[]; split: Split; parent?: Address; treasury: boolean };

type BuildCtx = {
  poolMap: Record<string, string>;
  sym: (a?: string) => string | undefined;
  routerToken: Record<string, Address>;
  treasuryToken: Record<string, Address>;
  launchDetails: Record<string, LaunchDetail>;
  minSwapWei: bigint;
  minBurnWei: bigint;
};

const DEFAULT_SPLIT: Split = { creatorBps: 10000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 };

// Resolve each launch's quote-asset pairs (quoteAssetsOf), its fee split + parent
// (from the FeeRouterCreated in the SAME tx), and whether its treasury holds
// backing (BackingLens). Bounded by launches in the range (typically few).
async function resolveLaunchDetails(client: ReturnType<typeof serverClient>, launches: TgEventWithMeta[], _poolMap: Record<string, string>): Promise<Record<string, LaunchDetail>> {
  const out: Record<string, LaunchDetail> = {};
  for (const e of launches) {
    if (e.kind !== "launch" || !e.txHash) continue;
    let pairAddrs: Address[] = WETH_ADDRESS ? [WETH_ADDRESS] : [];
    let split: Split = DEFAULT_SPLIT;
    let parent: Address | undefined;
    let treasury = false;
    // quote assets across factories (allowFailure — only the owner responds)
    try {
      const q = await client.multicall({ contracts: FACTORY_ADDRESSES.map((address) => ({ address, abi: ballastFactoryAbi, functionName: "quoteAssetsOf" as const, args: [e.token] as const })), allowFailure: true });
      const hit = q.find((r) => r.status === "success" && Array.isArray(r.result) && (r.result as Address[]).length > 0);
      if (hit && hit.status === "success") pairAddrs = hit.result as Address[];
    } catch { /* keep WETH default */ }
    // split + parent from the launch tx's FeeRouterCreated
    try {
      const receipt = await client.getTransactionReceipt({ hash: e.txHash });
      let router: Address | undefined;
      for (const log of receipt.logs) {
        try { const p = decodeEventLog({ abi: feeRouterFactoryAbi, ...log }); if (p.eventName === "FeeRouterCreated") router = (p.args as { router: Address }).router; } catch { /* */ }
      }
      if (router) {
        const r = await client.multicall({ contracts: (["creatorBps", "treasuryBps", "buybackBps", "parentBurnBps", "rewardsBps", "parent"] as const).map((fn) => ({ address: router!, abi: feeRouterV2Abi, functionName: fn })), allowFailure: true });
        const n = (i: number) => (r[i]?.status === "success" ? Number(r[i]!.result) : 0);
        split = { creatorBps: n(0), treasuryBps: n(1), buybackBps: n(2), parentBurnBps: n(3), rewardsBps: n(4) };
        const p = r[5];
        if (p?.status === "success" && p.result && (p.result as Address) !== "0x0000000000000000000000000000000000000000") parent = p.result as Address;
      }
    } catch { /* keep default split */ }
    // backing present?
    if (LENS_ADDRESS) {
      try {
        const b = (await client.readContract({ address: LENS_ADDRESS, abi: backingLensAbi, functionName: "backingOf", args: [e.treasury] })) as { totalValueUsd: bigint };
        treasury = b.totalValueUsd > 0n;
      } catch { /* leave false */ }
    }
    out[e.token.toLowerCase()] = { pairAddrs, split, parent, treasury };
  }
  return out;
}

/** The token an event is "about", for applying the hide list. Protocol-level
 *  events ($BALLAST buyback/burn) return undefined — never hidden. */
function tokenForHiding(
  e: TgEventWithMeta,
  poolMap: Record<string, string>,
  routerToken: Record<string, Address>,
  treasuryToken: Record<string, Address>,
): Address | undefined {
  switch (e.kind) {
    case "launch":
    case "poolSeeded":
    case "deadTransfer":
      return e.token;
    case "basketFill":
      return e.launchToken;
    case "swap":
      return poolMap[e.poolId.toLowerCase()]?.split("|")[0] as Address | undefined;
    case "splitScheduled":
    case "splitApplied":
    case "parentBurned":
      return routerToken[e.router.toLowerCase()];
    case "treasuryDeposit":
      return treasuryToken[e.treasury.toLowerCase()];
    default:
      return undefined;
  }
}

async function buildMessage(e: TgEventWithMeta, ctx: BuildCtx): Promise<string | null> {
  const tx = e.txHash!;
  switch (e.kind) {
    case "launch": {
      const d = ctx.launchDetails[e.token.toLowerCase()];
      const pairs = (d?.pairAddrs ?? (WETH_ADDRESS ? [WETH_ADDRESS] : [])).map((a) =>
        WETH_ADDRESS && a.toLowerCase() === WETH_ADDRESS.toLowerCase() ? "WETH" : (ctx.sym(a) ?? "?"),
      );
      return fmt.msgLaunch({
        token: e.token, symbol: ctx.sym(e.token), pairs: pairs.length ? pairs : ["WETH"],
        treasury: d?.treasury ?? false, split: d?.split ?? DEFAULT_SPLIT,
        parentSymbol: d?.parent ? ctx.sym(d.parent) : undefined, txHash: tx,
      });
    }
    case "swap": {
      const m = ctx.poolMap[e.poolId.toLowerCase()];
      if (!m) return null; // unknown pool (not one of ours, or seeded before the bot started)
      const [token, quoteAsset] = m.split("|") as [Address, Address];
      if (!WETH_ADDRESS || quoteAsset.toLowerCase() !== WETH_ADDRESS.toLowerCase()) return null; // ETH-threshold only applies to WETH pools
      // Determine which side is WETH (currency sort: lower address = currency0).
      const tokenIsC0 = token.toLowerCase() < WETH_ADDRESS.toLowerCase();
      const wethDelta = tokenIsC0 ? e.amount1 : e.amount0;
      const tokenDelta = tokenIsC0 ? e.amount0 : e.amount1;
      const absWeth = wethDelta < 0n ? -wethDelta : wethDelta;
      if (absWeth < ctx.minSwapWei) return null;
      const side: "buy" | "sell" = wethDelta > 0n ? "buy" : "sell";
      const absTok = tokenDelta < 0n ? -tokenDelta : tokenDelta;
      return fmt.msgSwap({ side, token, symbol: ctx.sym(token), ethAmount: Number(absWeth) / 1e18, tokenAmount: Number(absTok) / 1e18, isProtocol: token.toLowerCase() === BALLAST_V2_TOKEN_ADDRESS.toLowerCase(), txHash: tx });
    }
    case "buybackBurned": {
      const asset = e.asset.toLowerCase() === (WETH_ADDRESS?.toLowerCase() ?? "") ? "WETH" : (ctx.sym(e.asset) ?? "asset");
      return fmt.msgBuyback({ ballastBurned: Number(e.ballastBought) / 1e18, asset, spent: Number(e.spent) / 1e18, txHash: tx });
    }
    case "deadTransfer": {
      if (e.value < ctx.minBurnWei) return null;
      return fmt.msgBurn({ amount: Number(e.value) / 1e18, from: e.from, txHash: tx });
    }
    case "splitScheduled": {
      const token = ctx.routerToken[e.router.toLowerCase()];
      return fmt.msgSplitScheduled({ token: token ?? e.router, symbol: ctx.sym(token), split: e, effectiveAt: e.effectiveAt, txHash: tx });
    }
    case "splitApplied": {
      const token = ctx.routerToken[e.router.toLowerCase()];
      return fmt.msgSplitApplied({ token: token ?? e.router, symbol: ctx.sym(token), split: e, instant: e.instant, txHash: tx });
    }
    case "parentBurned": {
      return fmt.msgParentBurn({ parent: e.parent, parentSymbol: ctx.sym(e.parent), parentOut: Number(e.parentOut) / 1e18, txHash: tx });
    }
    case "treasuryDeposit": {
      const token = ctx.treasuryToken[e.treasury.toLowerCase()];
      return fmt.msgTreasuryDeposit({ token: token ?? e.treasury, symbol: ctx.sym(token), assetSymbol: ctx.sym(e.asset) ?? "asset", amount: Number(e.amount) / 1e18, txHash: tx });
    }
    case "basketFill": {
      return fmt.msgBasketFill({ token: e.launchToken, symbol: ctx.sym(e.launchToken), ethIn: Number(e.ethIn) / 1e18, nAssets: e.assets.length, txHash: tx });
    }
    default:
      return null;
  }
}
