"use client";

import { useProjects } from "@/hooks/useProjects";

// Protocol-wide aggregates, derived from the SAME useProjects hook Discover uses,
// so these totals reconcile with what Discover lists by construction — no
// separately-maintained counter (visual-upgrade §Analytics / spec §3.2). Every
// figure here is read live from the chain (factory registry + BackingLens), not
// the indexer, so it stays correct even when the indexer is down.
export type ProtocolStats = {
  isConfigured: boolean;
  isLoading: boolean;
  hasLaunches: boolean;
  launchesAllTime: number;
  ballastedCount: number;
  ballastedSharePct?: number; // undefined when there are no launches
  totalBallastUsd: bigint; // 1e18-scaled sum of every project's totalValueUsd
  lockedBallastUsd: bigint; // the portion that can never leave the treasuries
  medianBackingRatio: number | null; // null → needs a market-price source (see below)
};

export function useProtocolStats(): ProtocolStats {
  const { projects, count, isLoading, isConfigured, hasLaunches } = useProjects();

  let totalBallastUsd = 0n;
  let lockedBallastUsd = 0n;
  let ballastedCount = 0;
  // Per-project backing ratio = market price ÷ backing per token (both 1e18 USD),
  // for every ballasted project that has a live on-chain pool price. Collected here
  // to take the median below.
  const ratios: number[] = [];
  for (const p of projects) {
    if (p.backing) {
      totalBallastUsd += p.backing.totalValueUsd;
      lockedBallastUsd += p.backing.lockedValueUsd;
    }
    if (p.ballasted) ballastedCount++;
    if (p.marketPriceUsd !== undefined && p.backing && p.backing.backingPerToken > 0n) {
      ratios.push(Number((p.marketPriceUsd * 10n ** 18n) / p.backing.backingPerToken) / 1e18);
    }
  }

  // Median backing ratio, now sourced live: the market price is read on-chain from
  // the v4 StateView (same source Discover uses), so this no longer needs an indexer
  // or a quoter. Null only when NO ballasted project has a live pool price yet — an
  // honest "nothing to measure", not a fabricated 1.00×.
  ratios.sort((a, b) => a - b);
  const n = ratios.length;
  const medianBackingRatio =
    n === 0 ? null : n % 2 === 1 ? ratios[(n - 1) / 2]! : (ratios[n / 2 - 1]! + ratios[n / 2]!) / 2;

  return {
    isConfigured,
    isLoading,
    hasLaunches,
    launchesAllTime: count,
    ballastedCount,
    ballastedSharePct: count > 0 ? (ballastedCount / count) * 100 : undefined,
    totalBallastUsd,
    lockedBallastUsd,
    medianBackingRatio,
  };
}
