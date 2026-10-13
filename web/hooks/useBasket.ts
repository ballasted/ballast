"use client";

import { useMemo, useState, useEffect } from "react";
import { useReadContracts, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { ramsesQuoterAbi, aggregatorV3Abi } from "@/lib/abis";
import { useAssets, type AllowedAsset } from "@/hooks/useAssets";
import { RAMSES_QUOTER_ADDRESS, ETH_USD_FEED_ADDRESS } from "@/lib/contracts";
import { BASKET_PRESETS, isRoutable, type BasketPresetId } from "@/lib/basketRoutes";
import { routerV2RoutesFor, ramsesRoutesForIdx, WETH_TOKEN } from "@/lib/routerV2";
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
  quoteOut?: bigint; // live Ramses-route estimate for this leg's current ETH share
  /** Quote shortfall vs the Chainlink-implied fair output, in bps (>= 0).
   *  Undefined when either price is unavailable or the quote hasn't loaded. */
  impactBps?: number;
  /** Quote is so far below fair value the route is effectively dead right now
   *  (a floored pool quotes "honestly" — slippage alone can't catch this). */
  illiquid: boolean;
  /** minOut at the current slippage would be below the asset's registry
   *  minDeposit — the treasury deposit would revert BelowMinimum. */
  belowDepositMin: boolean;
};

/** Execution-time liquidity gate: block a leg whose live quote is more than
 *  this far below the Chainlink-implied fair output. Deliberately looser than
 *  the 3%-routability bar (docs/BASKET_DISCOVERY.md §2.2) — this is a safety
 *  net against a pool that got floored since the route was verified (observed
 *  on-fork: a drained pool "honestly" quoting a 99.9% loss), not a price
 *  guarantee. docs/DECISIONS.md §9. */
export const MAX_EXECUTION_IMPACT_BPS = 1_000;

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
  // Registry assets with NO verified route — shown in the picker as disabled
  // "not routable yet" chips (never selectable), so the set is visible rather
  // than silently hidden.
  const nonRoutable = useMemo(
    () => assets.filter((a) => a.symbol && !isRoutable(a.address)),
    [assets],
  );

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
    // Never allow a non-routable asset to be selected, even if called outside
    // the (already-disabled) picker chip. Deselecting is always allowed.
    if (!isRoutable(addr) && !selected.includes(addr)) return;
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

  // Pre-quote legs — the quote/impact/deposit-min fields are filled in by the
  // legsWithQuote enrichment below (which is what the hook returns).
  const legs = selected
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

  // Live per-leg quote through the asset's REAL Ramses route (1-hop direct or
  // 2-hop via USDG) — there is NO WETH/<asset> single-hop pool (the old model's
  // mistake). Imperative + sequential because 2-hop quotes chain (hop2 amountIn
  // = hop1 amountOut), which useReadContracts (parallel/independent) can't
  // express. Mirrors useRouterV2Swap.quoteRamsesLeg1 (buy direction). Fables is
  // BasketZap's preferred venue but is NOT quoted here (its off-chain quote is
  // unreliable on this chain — docs/BASKET_DISCOVERY.md §2.1); Ramses is the
  // venue we verified, and BasketZap tries Ramses-first for these legs anyway
  // (the leg builder sets preferFables=false).
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [quoteOutByAddr, setQuoteOutByAddr] = useState<Record<string, bigint>>({});

  const quoteKey =
    selected
      .map((a) => `${a.toLowerCase()}:${weights[a] ?? 0}`)
      .sort()
      .join("|") + `@${ethWei.toString()}`;

  useEffect(() => {
    let cancelled = false;
    if (!publicClient || !RAMSES_QUOTER_ADDRESS || ethWei === 0n) {
      setQuoteOutByAddr({});
      return;
    }
    (async () => {
      const out: Record<string, bigint> = {};
      for (const addr of selected) {
        const w = weights[addr] ?? 0;
        if (w === 0) continue;
        const routes = routerV2RoutesFor(addr);
        if (!routes || routes.ramsesHopIdx.length === 0) continue;
        const amountIn = (ethWei * BigInt(w)) / BigInt(BPS);
        if (amountIn === 0n) continue;
        try {
          out[addr.toLowerCase()] = await quoteRamsesBuy(publicClient, routes.ramsesHopIdx, amountIn);
        } catch {
          /* leave unquoted — allQuotesReady stays false and the confirm
             button is blocked (a missing quote must never degrade minOut) */
        }
      }
      if (!cancelled) setQuoteOutByAddr(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, quoteKey]);

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

  // Enrich each leg with its live quote plus the execution-liquidity gate:
  // slippage (minOut) only protects quote-vs-execution — a FLOORED pool quotes
  // its dead price "honestly", so the quote itself is checked against the
  // Chainlink-implied fair output, and minOut against the asset's registry
  // minDeposit (a deposit below it reverts BelowMinimum). docs/DECISIONS.md §9.
  const legsWithQuote: BasketAsset[] = legs.map((l) => {
    const quoteOut = quoteOutByAddr[l.address.toLowerCase()];
    const amountIn = (ethWei * BigInt(l.weightBps)) / BigInt(BPS);

    let impactBps: number | undefined;
    if (quoteOut !== undefined && ethUsd1e18 !== undefined && l.price !== undefined && l.priceDecimals !== undefined && l.price > 0n && amountIn > 0n) {
      const assetUsd1e18 = (l.price * 10n ** 18n) / 10n ** BigInt(l.priceDecimals);
      if (assetUsd1e18 > 0n) {
        const fairOut = (amountIn * ethUsd1e18) / assetUsd1e18;
        if (fairOut > 0n) {
          impactBps = quoteOut >= fairOut ? 0 : Number(((fairOut - quoteOut) * 10_000n) / fairOut);
        }
      }
    }

    const minOut = quoteOut !== undefined ? (quoteOut * BigInt(BPS - slippageBps)) / BigInt(BPS) : undefined;
    return {
      ...l,
      quoteOut,
      impactBps,
      illiquid: impactBps !== undefined && impactBps > MAX_EXECUTION_IMPACT_BPS,
      belowDepositMin: minOut !== undefined && l.minDeposit > 0n && minOut < l.minDeposit,
    };
  });

  const activeLegs = legsWithQuote.filter((l) => l.weightBps > 0);
  // Every active leg must have a live quote before the swap is allowed —
  // otherwise minOut would silently degrade to a floor of 1 wei (no real
  // slippage protection at all).
  const allQuotesReady = activeLegs.length > 0 && ethWei > 0n && activeLegs.every((l) => l.quoteOut !== undefined && l.quoteOut > 0n);
  const anyIlliquid = activeLegs.some((l) => l.illiquid);
  const anyBelowDepositMin = activeLegs.some((l) => l.belowDepositMin);

  return {
    isConfigured,
    isLoading,
    routable,
    nonRoutable,
    hasRoutableAssets: routable.length > 0,
    preset,
    applyPreset,
    toggleAsset,
    setWeightPct,
    legs: legsWithQuote,
    totalWeightBps,
    weightsValid,
    anyMarketClosed,
    allQuotesReady,
    anyIlliquid,
    anyBelowDepositMin,
    ethAmount,
    setEthAmount,
    ethWei,
    ethUsd1e18,
    slippageBps,
    setSlippageBps,
    launchTokenSymbol,
  };
}

/** Quote the buy-direction Ramses chain (WETH -> [USDG ->] asset) for
 *  `amountIn` wei, returning the asset-out amount. Sequential: each hop's
 *  output feeds the next hop's input. Mirrors
 *  useRouterV2Swap.quoteRamsesLeg1. */
async function quoteRamsesBuy(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  routeIdx: number[],
  amountIn: bigint,
): Promise<bigint> {
  const routeHops = ramsesRoutesForIdx(routeIdx);
  let cur: Address = WETH_TOKEN;
  let amt = amountIn;
  for (const r of routeHops) {
    const outAddr = cur.toLowerCase() === r.tokenA.toLowerCase() ? r.tokenB : r.tokenA;
    const res = await publicClient.simulateContract({
      address: RAMSES_QUOTER_ADDRESS!,
      abi: ramsesQuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: cur, tokenOut: outAddr, amountIn: amt, tickSpacing: r.tickSpacing, sqrtPriceLimitX96: 0n }],
    });
    amt = (res.result as readonly [bigint, bigint, number, bigint])[0];
    cur = outAddr;
  }
  return amt;
}
