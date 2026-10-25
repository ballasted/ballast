import { NextResponse } from "next/server";
import { formatUnits, type Address } from "viem";
import { serverClient } from "@/lib/serverChain";
import { backingLensAbi, assetRegistryAbi, erc20Abi } from "@/lib/abis";
import {
  LENS_ADDRESS,
  FEE_CONFIG_ADDRESS,
  ASSET_REGISTRY_ADDRESS,
  BUYBACK_ADDRESS,
  BUYBACK_V2_ADDRESS,
  ROUNDUP_ROUTER_ADDRESS,
  WETH_ADDRESS,
  DEAD_ADDRESS,
  isHiddenToken,
} from "@/lib/contracts";
import {
  getDiscoverStats,
  getAnalyticsSeries,
  getFeeFlowBase,
  getBurnTracker,
  getTopTokensByVolume,
  getTopCreatorsByVolume,
  getFamilies,
  getRoundupStats,
  getPairingRows,
  getLaunchesLite,
} from "@/lib/indexer/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Consolidated, protocol-wide Analytics payload — one call drives the whole page.
// Everything numeric comes from the on-chain indexer (Neon) except the live
// fee-split bps (read from FeeConfig so it's never hardcoded) and per-stock
// treasury exposure (read from BackingLens — not an indexed quantity). Returns
// { available:false } when the indexer is unconfigured/empty so the page keeps
// its current (GeckoTerminal) source rather than showing fake zeros.

const feeConfigReadAbi = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "creatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "platformBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

type AssetBacking = { asset: Address; lockedValueUsd: bigint; withdrawableValueUsd: bigint };
type BackingResult = { assets: readonly AssetBacking[] };

async function liveFeeBps(): Promise<{ feeBps: number; creatorBps: number; platformBps: number } | null> {
  if (!FEE_CONFIG_ADDRESS) return null;
  try {
    const res = await serverClient().multicall({
      allowFailure: true,
      contracts: [
        { address: FEE_CONFIG_ADDRESS, abi: feeConfigReadAbi, functionName: "feeBps" },
        { address: FEE_CONFIG_ADDRESS, abi: feeConfigReadAbi, functionName: "creatorBps" },
        { address: FEE_CONFIG_ADDRESS, abi: feeConfigReadAbi, functionName: "platformBps" },
      ],
    });
    if (res.some((r) => r.status !== "success")) return null;
    return {
      feeBps: Number(res[0].result),
      creatorBps: Number(res[1].result),
      platformBps: Number(res[2].result),
    };
  } catch {
    return null;
  }
}

/** Per-stock treasury exposure (USD), aggregated across every launch's treasury
 *  via BackingLens. All-zero today (nothing is ballasted) — reported honestly. */
async function treasuryExposure(
  treasuries: { treasury: string }[],
): Promise<{ total: number; byStock: { asset: string; exposureUsd: number }[] } | null> {
  const lens = LENS_ADDRESS;
  if (!lens || treasuries.length === 0) return null;
  try {
    const client = serverClient();
    const res = await client.multicall({
      allowFailure: true,
      contracts: treasuries.map((t) => ({ address: lens, abi: backingLensAbi, functionName: "backingOf" as const, args: [t.treasury as Address] })),
    });
    const byAsset = new Map<string, number>();
    for (const r of res) {
      if (r.status !== "success") continue;
      const b = r.result as unknown as BackingResult;
      for (const a of b.assets ?? []) {
        const usd = Number(formatUnits((a.lockedValueUsd ?? 0n) + (a.withdrawableValueUsd ?? 0n), 18));
        const k = (a.asset as string).toLowerCase();
        byAsset.set(k, (byAsset.get(k) ?? 0) + usd);
      }
    }
    // Union with the full allowlist so every eligible stock shows (0 if unused).
    try {
      if (ASSET_REGISTRY_ADDRESS) {
        const allowed = (await client.readContract({ address: ASSET_REGISTRY_ADDRESS, abi: assetRegistryAbi, functionName: "allowedAssets" })) as readonly Address[];
        for (const a of allowed) if (!byAsset.has(a.toLowerCase())) byAsset.set(a.toLowerCase(), 0);
      }
    } catch {
      // allowlist read failed — show only assets that appeared in backingOf
    }
    const byStock = [...byAsset.entries()].map(([asset, exposureUsd]) => ({ asset, exposureUsd })).sort((a, b) => b.exposureUsd - a.exposureUsd);
    return { total: byStock.reduce((s, x) => s + x.exposureUsd, 0), byStock };
  } catch {
    return null;
  }
}

async function symbolsFor(addrs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(addrs.map((a) => a.toLowerCase()).filter(Boolean))] as Address[];
  if (unique.length === 0) return out;
  try {
    const res = await serverClient().multicall({
      allowFailure: true,
      contracts: unique.map((address) => ({ address, abi: erc20Abi, functionName: "symbol" as const })),
    });
    unique.forEach((a, i) => {
      if (res[i]?.status === "success") out.set(a.toLowerCase(), res[i]!.result as string);
    });
  } catch {
    // leave unresolved — UI falls back to a short address
  }
  return out;
}

export async function GET() {
  const stats = await getDiscoverStats();
  if (stats === null) {
    // Indexer unconfigured or empty → the page keeps GeckoTerminal.
    return NextResponse.json({ available: false }, { headers: { "cache-control": "no-store" } });
  }

  const [series, feeBase, burn, topTokensRaw, topCreatorsRaw, families, roundupsRaw, launches, bps] = await Promise.all([
    getAnalyticsSeries(365),
    getFeeFlowBase(),
    getBurnTracker(100),
    getTopTokensByVolume(10),
    getTopCreatorsByVolume(10),
    getFamilies(),
    getRoundupStats(),
    getLaunchesLite(),
    liveFeeBps(),
  ]);

  // Pairing mix — classify each (non-hidden) launched token by its pools.
  const pairingRows = WETH_ADDRESS ? await getPairingRows(WETH_ADDRESS) : null;
  let pairing: { wethOnly: number; stockAndWeth: number; stockOnly: number; total: number } | null = null;
  if (pairingRows) {
    let wethOnly = 0, stockAndWeth = 0, stockOnly = 0;
    for (const r of pairingRows) {
      if (isHiddenToken(r.token as Address)) continue;
      if (r.hasWeth && r.hasStock) stockAndWeth++;
      else if (r.hasStock) stockOnly++;
      else if (r.hasWeth) wethOnly++;
    }
    pairing = { wethOnly, stockAndWeth, stockOnly, total: wethOnly + stockAndWeth + stockOnly };
  }

  // Exposure (live chain, best-effort).
  const treasuries = (launches ?? []).filter((l) => !isHiddenToken(l.token as Address)).map((l) => ({ treasury: l.treasury }));
  const exposureRaw = await treasuryExposure(treasuries);

  // Resolve symbols for every asset address we're about to surface.
  const assetAddrs = [
    ...(exposureRaw?.byStock.map((s) => s.asset) ?? []),
    ...(feeBase?.buybackByAsset.map((b) => b.asset) ?? []),
    ...(roundupsRaw?.byStock.map((s) => s.stock) ?? []),
  ].filter(Boolean);
  const sym = await symbolsFor(assetAddrs);
  const symOf = (a: string | null) => (a ? sym.get(a.toLowerCase()) ?? null : null);

  // Fee flow — layer the live bps over indexed volume. creator + platform == total.
  const feeBps = bps?.feeBps ?? null;
  const creatorBps = bps?.creatorBps ?? null;
  const platformBps = bps?.platformBps ?? null;
  const fee =
    feeBase && feeBps !== null
      ? (() => {
          const feeTotalUsd = (feeBase.volumeUsdAll * feeBps) / 10_000;
          const creatorUsd = creatorBps !== null ? (feeTotalUsd * creatorBps) / 10_000 : null;
          const platformUsd = platformBps !== null ? (feeTotalUsd * platformBps) / 10_000 : null;
          return {
            feeBps,
            creatorBps,
            platformBps,
            volumeUsdAll: feeBase.volumeUsdAll,
            feeTotalUsd,
            creatorUsd,
            platformUsd,
            parentBurnTokens: feeBase.parentBurnTokens,
            buyback: {
              runs: feeBase.buybackRuns,
              ballastTotal: feeBase.buybackBallastTotal,
              byAsset: feeBase.buybackByAsset.map((b) => ({ ...b, symbol: symOf(b.asset) })),
            },
          };
        })()
      : null;

  const topTokens = (topTokensRaw ?? []).map((t) => ({ ...t }));
  const topCreators =
    topCreatorsRaw && feeBps !== null
      ? topCreatorsRaw.map((c) => ({
          ...c,
          feeUsd: (c.volumeUsd * feeBps * (creatorBps ?? 10_000)) / 1e8,
        }))
      : (topCreatorsRaw ?? []).map((c) => ({ ...c, feeUsd: null }));

  const roundups = roundupsRaw
    ? { ...roundupsRaw, byStock: roundupsRaw.byStock.map((s) => ({ ...s, symbol: symOf(s.stock) })) }
    : { count: 0, ethIn: 0, byStock: [] as { stock: string; count: number; stockOut: number; symbol: string | null }[] };

  const exposure = exposureRaw
    ? { total: exposureRaw.total, byStock: exposureRaw.byStock.map((s) => ({ ...s, symbol: symOf(s.asset) })) }
    : null;

  return NextResponse.json(
    {
      available: true,
      stats,
      series: series ?? [],
      fee,
      burn: burn ?? { byToken: [], totalBurned: 0, buybacks: [] },
      topTokens,
      topCreators,
      families: families ?? [],
      roundups,
      pairing,
      exposure,
      addresses: {
        feeConfig: FEE_CONFIG_ADDRESS ?? null,
        buyback: BUYBACK_ADDRESS ?? null,
        buybackV2: BUYBACK_V2_ADDRESS ?? null,
        lens: LENS_ADDRESS ?? null,
        assetRegistry: ASSET_REGISTRY_ADDRESS ?? null,
        roundupRouter: ROUNDUP_ROUTER_ADDRESS ?? null,
        dead: DEAD_ADDRESS,
      },
    },
    { headers: { "cache-control": "public, s-maxage=120, stale-while-revalidate=600" } },
  );
}
