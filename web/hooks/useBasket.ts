"use client";

import { useMemo, useState } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { quoterAbi, aggregatorV3Abi } from "@/lib/abis";
import { useAssets, type AllowedAsset } from "@/hooks/useAssets";
import { QUOTER_ADDRESS, ETH_USD_FEED_ADDRESS, WETH_ADDRESS } from "@/lib/contracts";
import { BASKET_PRESETS, routeFor, isRoutable, type BasketPresetId } from "@/lib/basketRoutes";
import { evenSplit, snapWeight, BASKET_BPS } from "@/lib/basketWeights";
import { classifyFreshness, type Freshness } from "@/lib/marketHours";
import { useNow } from "@/hooks/useNow";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;
const BPS = BASKET_BPS;
const MAX_LEGS = 6;

export type BasketAsset = AllowedAsset & {
  weightBps: number;
  freshness?: Freshness;
  marketClosed: boolean;
  quoteOut?: bigint; // live V4Quoter estimate for this leg's current ETH share
};

/** Every AssetRegistry asset with a curated route (web/lib/basketRoutes.ts),
 *  cross-referenced with live freshness so a market-closed asset is flagged
 *  the same way Create's treasury-asset picker flags one (CLAUDE.md UI rule:
 *  never let a stale-price asset look pickable). Weights start even-split
 *  across whichever preset tickers actually have a route, and always snap to
 *  whole 1% (100bps) steps summing to exactly BPS. */
export function useBasket(launchTokenSymbol?: string) {
  const { assets, isConfigured, isLoading } = useAssets();
  const now = useNow();

  const routable = useMemo(() => assets.filter((a) => isRoutable(a.address)), [assets]);

  const [preset, setPreset] = useState<BasketPresetId>("index");
  const [selected, setSelected] = useState<Address[]>([]);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [slippageBps, setSlippageBps] = useState(100); // 1% default, user-adjustable

  function applyPreset(id: BasketPresetId) {
    setPreset(id);
    const tickers = BASKET_PRESETS.find((p) => p.id === id)?.tickers ?? [];
    const picks = routable.filter((a) => a.symbol && tickers.includes(a.symbol));
    const addrs = picks.map((a) => a.address);
    setSelected(addrs);
    setWeights(evenSplit(addrs));
  }

  function toggleAsset(addr: Address) {
    setPreset("custom");
    setSelected((prev) => {
      const next = prev.includes(addr)
        ? prev.filter((a) => a !== addr)
        : prev.length >= MAX_LEGS
          ? prev
          : [...prev, addr];
      setWeights(evenSplit(next));
      return next;
    });
  }

  function setWeightPct(addr: Address, pct: number) {
    setWeights(snapWeight(selected, addr, pct));
  }

  const legs: BasketAsset[] = selected
    .map((addr) => routable.find((a) => a.address === addr))
    .filter((a): a is AllowedAsset => Boolean(a))
    .map((a) => {
      const beyondBound = a.updatedAt !== undefined && a.staleAfter !== undefined && now - Number(a.updatedAt) > Number(a.staleAfter);
      const freshness = a.updatedAt !== undefined && now > 0 ? classifyFreshness(Number(a.updatedAt), a.marketHours, beyondBound, now) : undefined;
      return {
        ...a,
        weightBps: weights[a.address] ?? 0,
        freshness,
        marketClosed: freshness?.tier === "stale",
      };
    });

  const totalWeightBps = legs.reduce((sum, l) => sum + l.weightBps, 0);
  const weightsValid = legs.length > 0 && totalWeightBps === BPS;
  const anyMarketClosed = legs.some((l) => l.marketClosed);

  const [ethAmount, setEthAmount] = useState("");
  const ethWei = useMemo(() => {
    try {
      return ethAmount ? BigInt(Math.round(Number(ethAmount) * 1e18)) : 0n;
    } catch {
      return 0n;
    }
  }, [ethAmount]);

  // Live per-leg quote via V4Quoter, at this leg's current ETH share.
  const quoteContracts = useMemo(
    () =>
      legs
        .filter((l) => ethWei > 0n && l.weightBps > 0)
        .map((l) => {
          const route = routeFor(l.address);
          if (!route || !WETH_ADDRESS) return null;
          const amountIn = (ethWei * BigInt(l.weightBps)) / BigInt(BPS);
          const wethIsCurrency0 = WETH_ADDRESS.toLowerCase() < l.address.toLowerCase();
          const poolKey = {
            currency0: wethIsCurrency0 ? WETH_ADDRESS : l.address,
            currency1: wethIsCurrency0 ? l.address : WETH_ADDRESS,
            fee: route.fee,
            tickSpacing: route.tickSpacing,
            hooks: route.hooks,
          };
          return {
            address: QUOTER_ADDRESS!,
            abi: quoterAbi,
            functionName: "quoteExactInputSingle",
            args: [{ poolKey, zeroForOne: wethIsCurrency0, exactAmount: amountIn, hookData: "0x" as const }],
            chainId: CHAIN_ID,
          } as const;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null),
    [legs, ethWei],
  );
  const quoteRes = useReadContracts({
    allowFailure: true,
    contracts: quoteContracts,
    query: { enabled: Boolean(QUOTER_ADDRESS) && quoteContracts.length > 0 },
  });
  let qi = 0;
  const legsWithQuote = legs.map((l) => {
    if (ethWei === 0n || l.weightBps === 0 || !routeFor(l.address)) return l;
    const r = quoteRes.data?.[qi];
    qi++;
    if (r?.status === "success") {
      const [amountOut] = r.result as unknown as [bigint, bigint];
      return { ...l, quoteOut: amountOut };
    }
    return l;
  });

  const ethUsdRes = useReadContracts({
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
  if (ethUsdRes.data?.[0]?.status === "success" && ethUsdRes.data?.[1]?.status === "success") {
    const answer = (ethUsdRes.data[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    const dec = ethUsdRes.data[1].result as number;
    if (answer > 0n) ethUsd1e18 = (answer * 10n ** 18n) / 10n ** BigInt(dec);
  }

  return {
    isConfigured,
    isLoading,
    routable,
    hasRoutableAssets: routable.length > 0,
    preset,
    applyPreset,
    toggleAsset,
    setWeightPct,
    legs: legsWithQuote,
    totalWeightBps,
    weightsValid,
    anyMarketClosed,
    ethAmount,
    setEthAmount,
    ethWei,
    ethUsd1e18,
    slippageBps,
    setSlippageBps,
    launchTokenSymbol,
  };
}
