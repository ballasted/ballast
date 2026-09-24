"use client";

import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { ballastFactoryAbi, stateViewAbi, erc20Abi } from "@/lib/abis";
import {
  FACTORY_ADDRESSES,
  STATE_VIEW_ADDRESS,
  WETH_ADDRESS,
  hookForFactory,
  isFactoryConfigured,
  isSwapConfigured,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { candidatePoolKeys, poolKeyForToken, poolId, tokenIsCurrency0, tokenPriceInQuote } from "@/lib/pool";
import { liveQuery } from "@/lib/refresh";

const CHAIN_ID = activeChain.id;

export type QuotePoolOption = {
  quoteAsset: Address;
  symbol: string;
  isWeth: boolean;
  hook: Address;
  hasPool: boolean;
  marketPriceInQuote?: bigint; // 1 token in whole units of quoteAsset, 1e18-scaled
};

/**
 * Every LIVE pool a token can trade against, additive to (and independent from)
 * useBacking's WETH-only price/backing math — nothing there changes. A launch may
 * pair its token against WETH and/or up to MAX_QUOTE_ASSETS GREEN assets
 * (BallastFactory.quoteAssetsOf), each graduating into its own pool, so the trade
 * surface needs to know ALL of them, not just WETH. A prior factory that predates
 * quoteAssetsOf() simply fails that call (allowFailure) and falls back to
 * WETH-only, matching its actual (single-quote-asset) launch shape.
 */
export function useTokenQuotePools(token: Address | undefined) {
  const ownerRes = useReadContracts({
    allowFailure: true,
    contracts: token
      ? FACTORY_ADDRESSES.map(
          (f) => ({ address: f, abi: ballastFactoryAbi, functionName: "launchIdOf", args: [token], chainId: CHAIN_ID }) as const,
        )
      : [],
    query: liveQuery(isFactoryConfigured && Boolean(token) && FACTORY_ADDRESSES.length > 0),
  });
  let ownerFactory: Address | undefined;
  for (let i = 0; i < FACTORY_ADDRESSES.length; i++) {
    const r = ownerRes.data?.[i];
    if (r?.status === "success" && (r.result as bigint) > 0n) {
      ownerFactory = FACTORY_ADDRESSES[i];
      break;
    }
  }

  const quoteAssetsRes = useReadContract({
    address: ownerFactory,
    abi: ballastFactoryAbi,
    functionName: "quoteAssetsOf",
    args: token ? [token] : undefined,
    chainId: CHAIN_ID,
    query: { ...liveQuery(Boolean(token && ownerFactory)), retry: false },
  });
  // Prior (single-quote-asset) factories don't have quoteAssetsOf at all — the
  // call fails, and the only quote asset a launch from one of those could ever
  // have graduated against is WETH.
  const quoteAssets: Address[] =
    quoteAssetsRes.status === "success" && Array.isArray(quoteAssetsRes.data)
      ? (quoteAssetsRes.data as Address[])
      : WETH_ADDRESS
        ? [WETH_ADDRESS]
        : [];

  const pairedHook = hookForFactory(ownerFactory);
  const perAsset = quoteAssets.map((qa) => {
    const isWeth = Boolean(WETH_ADDRESS) && qa.toLowerCase() === WETH_ADDRESS!.toLowerCase();
    const candidates =
      !token
        ? []
        : pairedHook
          ? (() => {
              const key = poolKeyForToken(token, qa, pairedHook);
              return key ? [{ hook: pairedHook, key, id: poolId(key) }] : [];
            })()
          : candidatePoolKeys(token, qa);
    return { quoteAsset: qa, isWeth, candidates };
  });

  const symbolRes = useReadContracts({
    allowFailure: true,
    contracts: perAsset
      .filter((p) => !p.isWeth)
      .map((p) => ({ address: p.quoteAsset, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID }) as const),
    query: liveQuery(perAsset.some((p) => !p.isWeth)),
  });

  const poolRes = useReadContracts({
    allowFailure: true,
    contracts: perAsset.flatMap((p) =>
      STATE_VIEW_ADDRESS
        ? p.candidates.flatMap((c) => [
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getSlot0", args: [c.id], chainId: CHAIN_ID } as const,
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getLiquidity", args: [c.id], chainId: CHAIN_ID } as const,
          ])
        : [],
    ),
    query: liveQuery(isSwapConfigured && perAsset.some((p) => p.candidates.length > 0)),
  });

  let cursor = 0;
  let symCursor = 0;
  const options: QuotePoolOption[] = [];
  for (const p of perAsset) {
    let symbol = "WETH";
    if (!p.isWeth) {
      const r = symbolRes.data?.[symCursor];
      symbol = r?.status === "success" ? (r.result as string) : "";
      symCursor += 1;
    }
    let hasPool = false;
    let hook: Address | undefined;
    let marketPriceInQuote: bigint | undefined;
    for (const c of p.candidates) {
      const slot0 = poolRes.data?.[cursor];
      cursor += 2; // still advances past the paired getLiquidity read, unused for this gate now
      // A pool that's genuinely never been initialized reads sqrtPriceX96 === 0
      // (v4's real zero-state); ANY graduated Ballast pool has it set permanently
      // by PoolManager.initialize() at seed time. This is a correct, always-real
      // signal for "does a pool exist" — unlike getLiquidity(poolId), which reads
      // 0 exactly when the current tick sits on the seeded position's boundary
      // (the half-open tick-range artifact, confirmed on real graduated pools
      // 2026-09-25) even though the position is real and fully seeded.
      if (slot0?.status === "success" && token) {
        const [sqrtPriceX96] = slot0.result as unknown as [bigint, number, number, number];
        if (sqrtPriceX96 > 0n) {
          hasPool = true;
          hook = c.hook;
          marketPriceInQuote = tokenPriceInQuote(sqrtPriceX96, tokenIsCurrency0(token, p.quoteAsset), 18);
          break;
        }
      }
    }
    if (hasPool && hook) {
      options.push({ quoteAsset: p.quoteAsset, symbol, isWeth: p.isWeth, hook, hasPool, marketPriceInQuote });
    }
  }

  // WETH first (the familiar default), then everything else in quoteAssetsOf order.
  options.sort((a, b) => (a.isWeth === b.isWeth ? 0 : a.isWeth ? -1 : 1));

  return {
    options,
    isLoading: ownerRes.isLoading || quoteAssetsRes.isLoading || symbolRes.isLoading || poolRes.isLoading,
  };
}
