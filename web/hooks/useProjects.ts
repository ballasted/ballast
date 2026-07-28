"use client";

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import {
  backingLensAbi,
  erc20Abi,
  ballastFactoryAbi,
  ballastTokenAbi,
  stateViewAbi,
  aggregatorV3Abi,
} from "@/lib/abis";
import {
  LENS_ADDRESS,
  FACTORY_ADDRESSES,
  STATE_VIEW_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  isLensConfigured,
  isFactoryConfigured,
  isSwapConfigured,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { poolKeyForToken, poolId, priceFromSqrtX96 } from "@/lib/pool";

const CHAIN_ID = activeChain.id;

export type ProjectBacking = {
  sequencerStatus: number; // 0 Unknown, 1 Up, 2 GracePeriod, 3 Down
  totalSupply: bigint;
  lockedValueUsd: bigint;
  withdrawableValueUsd: bigint;
  totalValueUsd: bigint;
  backingPerToken: bigint;
  lockedBackingPerToken: bigint;
  anyStale: boolean;
  anyUnpriced: boolean;
  assets: readonly unknown[];
};

export type Project = {
  treasury: Address;
  token: Address;
  creator: Address;
  name?: string;
  symbol?: string;
  metadataURI?: string; // on-chain ipfs://CID → resolves to the logo/metadata JSON
  backing?: ProjectBacking;
  ballasted: boolean; // has any backing value
  hasPool: boolean; // a seeded v4 pool exists (liquidity > 0)
  marketPriceWeth?: bigint; // WETH per token, 1e18 — pool mid
  marketPriceUsd?: bigint; // USD per token, 1e18 — pool mid × ETH/USD
};

/**
 * Enumerates every launch across the multi-factory UNION (each factory's
 * launchCount + launches[i]) — the ONLY per-launch address source — dedupes by
 * token (newest factory wins), then reads each treasury's backing through
 * BackingLens plus the token name/symbol, all batched via multicall. No env
 * address list of launches: Discover is the registry(ies), live. Factories are
 * ordered newest-first (FACTORY_ADDRESSES); rows are emitted chronologically
 * ascending so callers that reverse for "newest first" stay correct.
 */
export function useProjects() {
  const factories = FACTORY_ADDRESSES; // newest-first

  // launchCount for each factory in the union.
  const countsRes = useReadContracts({
    allowFailure: true,
    contracts: factories.map((address) => ({
      address,
      abi: ballastFactoryAbi,
      functionName: "launchCount",
      chainId: CHAIN_ID,
    })),
    query: { enabled: isFactoryConfigured && factories.length > 0 },
  });
  const counts = factories.map((_, k) => {
    const r = countsRes.data?.[k];
    return r?.status === "success" ? Number(r.result as bigint) : 0;
  });

  // Flat (factoryIndex, launchIndex) refs across every factory.
  const refs: { factoryIndex: number; i: number }[] = [];
  factories.forEach((_, k) => {
    const c = counts[k] ?? 0;
    for (let i = 0; i < c; i++) refs.push({ factoryIndex: k, i });
  });

  // Registry rows: launches[i] => {token, treasury, creator}, per factory.
  const rowsRes = useReadContracts({
    allowFailure: true,
    contracts: refs.map((ref) => ({
      address: factories[ref.factoryIndex]!,
      abi: ballastFactoryAbi,
      functionName: "launches",
      args: [BigInt(ref.i)],
      chainId: CHAIN_ID,
    })),
    query: { enabled: isFactoryConfigured && refs.length > 0 },
  });

  // Dedupe by token and order chronologically. Each row gets a sequence number:
  // older factory → smaller, and within a factory a higher launch index → larger,
  // so seq ascending == launch order across the whole union. On the (defensive:
  // CREATE2 mining makes it all but impossible) case of one token in two
  // registries, the NEWEST factory wins — it's the live registry and its
  // treasury/creator record is the authoritative one.
  const byToken = new Map<string, { row: readonly [Address, Address, Address]; seq: number }>();
  refs.forEach((ref, idx) => {
    const r = rowsRes.data?.[idx];
    if (r?.status !== "success") return;
    const row = r.result as unknown as readonly [Address, Address, Address];
    const rank = factories.length - 1 - ref.factoryIndex; // newest → highest
    const seq = rank * 10_000_000 + ref.i;
    const key = row[0].toLowerCase();
    const existing = byToken.get(key);
    if (!existing || seq > existing.seq) byToken.set(key, { row, seq });
  });
  const rows = [...byToken.values()].sort((a, b) => a.seq - b.seq).map((e) => e.row);

  // backingOf(treasury) + token name/symbol for each launch.
  const dataRes = useReadContracts({
    allowFailure: true,
    contracts: rows.flatMap((row) =>
      row
        ? [
            {
              address: LENS_ADDRESS!,
              abi: backingLensAbi,
              functionName: "backingOf",
              args: [row[1]],
              chainId: CHAIN_ID,
            } as const,
            {
              address: row[0],
              abi: erc20Abi,
              functionName: "name",
              chainId: CHAIN_ID,
            } as const,
            {
              address: row[0],
              abi: erc20Abi,
              functionName: "symbol",
              chainId: CHAIN_ID,
            } as const,
            {
              address: row[0],
              abi: ballastTokenAbi,
              functionName: "metadataURI",
              chainId: CHAIN_ID,
            } as const,
          ]
        : [],
    ),
    query: { enabled: isLensConfigured && rows.some(Boolean) },
  });

  // Live market price per token, read on-chain from the v4 StateView (getSlot0 +
  // getLiquidity) — the SAME source the token page uses, so Discover and the token
  // page never disagree. An on-chain price is always available once a pool exists;
  // Discover previously showed "—" only because it never asked (it read no pool
  // state at all). Gated on isSwapConfigured (needs StateView + hook + WETH).
  const pids = rows.map((row) => (isSwapConfigured ? poolId(poolKeyForToken(row[0])!) : undefined));
  const poolRes = useReadContracts({
    allowFailure: true,
    contracts: pids.flatMap((pid) =>
      pid && STATE_VIEW_ADDRESS
        ? [
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getSlot0", args: [pid], chainId: CHAIN_ID } as const,
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getLiquidity", args: [pid], chainId: CHAIN_ID } as const,
          ]
        : [],
    ),
    query: { enabled: isSwapConfigured && pids.some(Boolean) },
  });
  const ethRes = useReadContracts({
    allowFailure: true,
    contracts: ETH_USD_FEED_ADDRESS
      ? [
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "latestRoundData", chainId: CHAIN_ID },
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "decimals", chainId: CHAIN_ID },
        ]
      : [],
    query: { enabled: Boolean(ETH_USD_FEED_ADDRESS) },
  });
  let ethUsd1e18: bigint | undefined;
  if (ethRes.data?.[0]?.status === "success" && ethRes.data?.[1]?.status === "success") {
    const answer = (ethRes.data[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer > 0n) ethUsd1e18 = (answer * 10n ** 18n) / 10n ** BigInt(ethRes.data[1].result as number);
  }

  const projects: Project[] = [];
  let cursor = 0;
  let poolCursor = 0;
  for (const row of rows) {
    const [token, treasury, creator] = row;
    const b = dataRes.data?.[cursor];
    const nm = dataRes.data?.[cursor + 1];
    const sy = dataRes.data?.[cursor + 2];
    const uri = dataRes.data?.[cursor + 3];
    cursor += 4;

    // Pool state is present only when isSwapConfigured (pids were built the same
    // way), so the cursor advances in lockstep with the contracts array.
    let hasPool = false;
    let marketPriceWeth: bigint | undefined;
    let marketPriceUsd: bigint | undefined;
    if (isSwapConfigured && STATE_VIEW_ADDRESS) {
      const slot0 = poolRes.data?.[poolCursor];
      const liq = poolRes.data?.[poolCursor + 1];
      poolCursor += 2;
      hasPool = liq?.status === "success" && (liq.result as bigint) > 0n;
      if (hasPool && slot0?.status === "success") {
        const [sqrtPriceX96] = slot0.result as unknown as [bigint, number, number, number];
        if (sqrtPriceX96 > 0n) marketPriceWeth = priceFromSqrtX96(sqrtPriceX96);
      }
      if (marketPriceWeth !== undefined && ethUsd1e18 !== undefined) {
        marketPriceUsd = (marketPriceWeth * ethUsd1e18) / 10n ** 18n;
      }
    }

    const backing =
      b?.status === "success" ? (b.result as unknown as ProjectBacking) : undefined;
    projects.push({
      token,
      treasury,
      creator,
      name: nm?.status === "success" ? (nm.result as string) : undefined,
      symbol: sy?.status === "success" ? (sy.result as string) : undefined,
      metadataURI: uri?.status === "success" ? (uri.result as string) : undefined,
      backing,
      ballasted: Boolean(backing && backing.totalValueUsd > 0n),
      hasPool,
      marketPriceWeth,
      marketPriceUsd,
    });
  }

  const count = rows.length; // deduped union size

  return {
    projects,
    isLoading:
      countsRes.isLoading || rowsRes.isLoading || (rows.length > 0 && dataRes.isLoading),
    isConfigured: isLensConfigured && isFactoryConfigured,
    hasLaunches: count > 0,
    count,
    error: countsRes.error ?? rowsRes.error,
  };
}
