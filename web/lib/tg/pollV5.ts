import "server-only";
import { getAbiItem, type Address, type Hex } from "viem";
import { serverClient } from "@/lib/serverChain";
import { erc20Abi, poolManagerAbi } from "@/lib/abis";
import { ballastFactoryV5Abi, protocolFeeVaultAbi } from "@/lib/abisV5";
import {
  FACTORY_ADDRESS,
  POOL_MANAGER_ADDRESS,
  PROTOCOL_FEE_VAULT_ADDRESS,
  WHYPE_ADDRESS,
  WETH_ADDRESS,
  isHiddenToken,
} from "@/lib/contracts";
import { profile } from "@/lib/chainProfile";
import {
  TG,
  MAX_BLOCKS_PER_RUN,
  MAX_MESSAGES_PER_RUN,
  CHAIN_KV_CURSOR_KEY,
  CHAIN_KV_POOLMAP_KEY,
} from "./config";
import { kvGet, kvSet, kvSetDedup, kvHGetAll, kvHSet } from "./kv";
import { decodeTgLogV5, type TgEventV5WithMeta } from "./decodeV5";
import { sendMessage, sendAnimation, type AnimKind } from "./telegram";
import { classifySwap } from "./swapDirection";
import * as fmt from "./format";

// ─────────────────────────────────────────────────────────────────────────────
// Gen-5 (Elysium, chain 99901) Telegram poll. Mirrors the gen-4 pipeline in
// app/api/tg/poll/route.ts (cursor in KV → getLogs window → decode → threshold →
// dedup → send) but reads gen-5 events (abisV5) and classifies swaps against WHYPE.
//
// Selected by the caller when profile.key === "elysium". Uses SEPARATE KV keys
// (CHAIN_KV_*) so the two Vercel deployments of this one codebase never clobber
// each other's cursor / pool map. Every posted message is tagged
// "Elysium · Gen 5 beta · …" and links elyscan.live (profile.explorerUrl).
//
// The three "must post" kinds: LAUNCHES (Factory.Launched), BUYS (PoolManager.Swap
// over a WHYPE pool, ≥ TG_MIN_SWAP_HYPE), and SWEEPS (ProtocolFeeVault.Forwarded).
// Sells follow the same TG_POST_SELLS switch as gen-4. FeeTaken is decoded but not
// posted (it fires on every swap — pure noise in the channel).
// ─────────────────────────────────────────────────────────────────────────────

// Same RPC-cap guard as the gen-4 route: a wide range (notably the first-run pool
// seed over 0..tip) must be split or the single getLogs call throws and silently
// returns nothing. Each chunk is independently try/caught.
const GETLOGS_MAX_SPAN = 9_000_000n;

// Per-chain message tag. Built from the profile/label so it stays in step with the
// "Gen 5 · beta" label; the exact channel wording the product asked for is
// "Elysium · Gen 5 beta".
const CHAIN_PREFIX = "Elysium · Gen 5 beta";
const CHAIN_CTX = { prefix: CHAIN_PREFIX, explorer: profile.explorerUrl } as const;

type Client = ReturnType<typeof serverClient>;

async function getLogsV5(
  client: Client,
  params: { address?: Address; abi: readonly unknown[]; eventName: string; from: bigint; to: bigint },
): Promise<TgEventV5WithMeta[]> {
  const event = getAbiItem({ abi: params.abi as never, name: params.eventName as never });
  const out: TgEventV5WithMeta[] = [];
  for (let lo = params.from; lo <= params.to; lo += GETLOGS_MAX_SPAN) {
    const hi = lo + GETLOGS_MAX_SPAN - 1n > params.to ? params.to : lo + GETLOGS_MAX_SPAN - 1n;
    try {
      const logs = (await client.getLogs({ address: params.address, event: event as never, fromBlock: lo, toBlock: hi })) as Array<{
        transactionHash?: Hex | null;
        logIndex?: number | null;
        address?: Address;
        topics: [Hex, ...Hex[]];
        data: Hex;
      }>;
      for (const log of logs) {
        const ev = decodeTgLogV5(log);
        if (ev) out.push({ ...ev, txHash: log.transactionHash ?? undefined, logIndex: log.logIndex ?? undefined, address: log.address as Address });
      }
    } catch {
      // best-effort per chunk (pool-map seed and per-run reads both tolerate it)
    }
  }
  return out;
}

// Graduated(token, quoteAsset, poolId,…) → poolId -> "token|quoteAsset". Gen-5 has
// NO PoolSeeded event, so graduation is the only source of the pool→token map.
async function seedPoolMapV5(client: Client, from: bigint, to: bigint): Promise<void> {
  if (!FACTORY_ADDRESS) return;
  const grads = await getLogsV5(client, { address: FACTORY_ADDRESS, abi: ballastFactoryV5Abi, eventName: "Graduated", from, to });
  for (const e of grads) {
    if (e.kind !== "graduatedV5") continue;
    await kvHSet(CHAIN_KV_POOLMAP_KEY, e.poolId.toLowerCase(), `${e.token}|${e.quoteAsset}`).catch(() => {});
  }
}

async function resolveSymbols(client: Client, addrs: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(addrs.map((a) => a.toLowerCase()))].filter(Boolean) as Address[];
  if (unique.length === 0) return {};
  const res = await client.multicall({
    contracts: unique.map((address) => ({ address, abi: erc20Abi, functionName: "symbol" as const })),
    allowFailure: true,
  });
  const out: Record<string, string> = {};
  unique.forEach((a, i) => {
    const r = res[i];
    if (r?.status === "success") out[a] = String(r.result);
  });
  return out;
}

type BuiltMsg = { text: string; anim?: AnimKind };

/** Run one Elysium poll cycle. Returns a JSON-serialisable summary for the route. */
export async function pollElysium(client: Client, latest: bigint): Promise<Record<string, unknown>> {
  if (!FACTORY_ADDRESS || !POOL_MANAGER_ADDRESS) {
    return { skipped: "elysium chain addresses not configured", chain: "elysium" };
  }
  // The WHYPE quote address (alias of WETH_ADDRESS on Elysium).
  const whype = (WHYPE_ADDRESS ?? WETH_ADDRESS) as Address | undefined;

  // First run ever: seed the pool map (reads only) and set the cursor at the tip.
  // NEVER backfill history into the channel.
  const cursorRaw = await kvGet(CHAIN_KV_CURSOR_KEY);
  if (cursorRaw === null) {
    await seedPoolMapV5(client, 0n, latest);
    await kvSet(CHAIN_KV_CURSOR_KEY, latest.toString());
    return { firstRun: true, cursor: latest.toString(), chain: "elysium" };
  }

  const from = BigInt(cursorRaw) + 1n;
  if (from > latest) return { upToDate: true, cursor: cursorRaw, chain: "elysium" };
  const to = from + MAX_BLOCKS_PER_RUN - 1n > latest ? latest : from + MAX_BLOCKS_PER_RUN - 1n;

  // Keep the pool map current for swap resolution.
  await seedPoolMapV5(client, from, to);
  const poolMap = await kvHGetAll(CHAIN_KV_POOLMAP_KEY);

  const [launches, swaps, sweeps] = await Promise.all([
    getLogsV5(client, { address: FACTORY_ADDRESS, abi: ballastFactoryV5Abi, eventName: "Launched", from, to }),
    getLogsV5(client, { address: POOL_MANAGER_ADDRESS, abi: poolManagerAbi, eventName: "Swap", from, to }),
    PROTOCOL_FEE_VAULT_ADDRESS
      ? getLogsV5(client, { address: PROTOCOL_FEE_VAULT_ADDRESS, abi: protocolFeeVaultAbi, eventName: "Forwarded", from, to })
      : Promise.resolve([] as TgEventV5WithMeta[]),
  ]);

  const all: TgEventV5WithMeta[] = [...launches, ...swaps, ...sweeps];

  // Resolve symbols for every token/currency we might print.
  const tokenAddrs = new Set<string>();
  for (const e of all) {
    if (e.kind === "launchV5") tokenAddrs.add(e.token);
    if (e.kind === "swap") {
      const m = poolMap[e.poolId.toLowerCase()];
      if (m) tokenAddrs.add(m.split("|")[0]!);
    }
    if (e.kind === "sweep") tokenAddrs.add(e.currency);
  }
  const symbols = await resolveSymbols(client, [...tokenAddrs]);
  const sym = (a?: string) => (a ? symbols[a.toLowerCase()] : undefined);
  const quoteLabel = (a: string) =>
    whype && a.toLowerCase() === whype.toLowerCase() ? profile.quoteSymbol : (sym(a) ?? "asset");

  const minSwapWei = BigInt(Math.round(TG.minSwapHype * 1e18));
  const skipBuyTokens = new Set(TG.skipTokens.map((a) => a.toLowerCase()));
  const built: BuiltMsg[] = [];
  const counts: Record<string, number> = {};

  for (const e of all) {
    if (!e.txHash || e.logIndex === undefined) continue;
    // Never post activity for a hidden (test/smoke) token.
    const hideTok = tokenForHiding(e, poolMap);
    if (hideTok && isHiddenToken(hideTok)) continue;

    const msg = buildMessageV5(e, { poolMap, sym, quoteLabel, whype, minSwapWei, skipBuyTokens });
    if (!msg) continue;
    const dedupKey = `tg:ely:seen:${e.txHash}:${e.logIndex}`;
    const fresh = await kvSetDedup(dedupKey).catch(() => true);
    if (!fresh) continue;
    built.push(msg);
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }

  let sent = 0;
  const toSend: BuiltMsg[] =
    built.length <= MAX_MESSAGES_PER_RUN
      ? built
      : [...built.slice(0, MAX_MESSAGES_PER_RUN - 1), { text: `${CHAIN_PREFIX} · ${fmt.msgDigest(built.length - (MAX_MESSAGES_PER_RUN - 1), counts)}` }];
  for (const m of toSend) {
    try {
      const r = m.anim ? await sendAnimation(m.anim, m.text) : await sendMessage(m.text);
      if (r.sent || r.dryRun) sent++;
    } catch (err) {
      console.error("[tg:ely] send failed", (err as Error).message);
    }
  }

  await kvSet(CHAIN_KV_CURSOR_KEY, to.toString());
  return { from: from.toString(), to: to.toString(), decoded: all.length, posted: sent, counts, dryRun: TG.dryRun, chain: "elysium" };
}

/** The token an event is "about", for applying the hide list. */
function tokenForHiding(e: TgEventV5WithMeta, poolMap: Record<string, string>): Address | undefined {
  switch (e.kind) {
    case "launchV5":
      return e.token;
    case "swap":
      return poolMap[e.poolId.toLowerCase()]?.split("|")[0] as Address | undefined;
    default:
      return undefined;
  }
}

type BuildCtx = {
  poolMap: Record<string, string>;
  sym: (a?: string) => string | undefined;
  quoteLabel: (a: string) => string;
  whype?: Address;
  minSwapWei: bigint;
  skipBuyTokens: Set<string>;
};

function buildMessageV5(e: TgEventV5WithMeta, ctx: BuildCtx): BuiltMsg | null {
  const tx = e.txHash!;
  switch (e.kind) {
    case "launchV5": {
      const pair = ctx.whype && e.quoteAsset.toLowerCase() === ctx.whype.toLowerCase() ? profile.quoteSymbol : (ctx.sym(e.quoteAsset) ?? "?");
      return {
        anim: "launch",
        text: fmt.msgLaunch({
          ...CHAIN_CTX,
          token: e.token,
          symbol: ctx.sym(e.token),
          pairs: [pair],
          // Gen-5 has no ProjectTreasury and no backing disclosure.
          treasury: false,
          // Gen-5 launches carry only a per-pool swap fee, not the gen-4 fee split.
          split: { creatorBps: 10000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 },
          txHash: tx,
        }),
      };
    }
    case "swap": {
      const m = ctx.poolMap[e.poolId.toLowerCase()];
      if (!m) return null; // unknown pool (not one of ours, or graduated before the bot started)
      const [token, quoteAsset] = m.split("|") as [Address, Address];
      if (!ctx.whype || quoteAsset.toLowerCase() !== ctx.whype.toLowerCase()) return null; // HYPE threshold only applies to WHYPE pools
      const { side, tokenAbs, quoteAbs } = classifySwap(token, ctx.whype, e.amount0, e.amount1);
      if (quoteAbs < ctx.minSwapWei) return null;
      if (side === "sell" && !TG.postSells) return null;
      if (side === "buy" && ctx.skipBuyTokens.has(token.toLowerCase())) return null;
      return {
        anim: side,
        text: fmt.msgSwap({ ...CHAIN_CTX, side, token, symbol: ctx.sym(token), ethAmount: Number(quoteAbs) / 1e18, tokenAmount: Number(tokenAbs) / 1e18, isProtocol: false, txHash: tx }),
      };
    }
    case "sweep": {
      return {
        text: fmt.msgSweep({ ...CHAIN_CTX, assetSymbol: ctx.quoteLabel(e.currency), amount: Number(e.amount) / 1e18, txHash: tx }),
      };
    }
    default:
      // feeTaken / graduatedV5 are consumed for the pool map / decoding only.
      return null;
  }
}
