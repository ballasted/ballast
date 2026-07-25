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
  for (const p of projects) {
    if (p.backing) {
      totalBallastUsd += p.backing.totalValueUsd;
      lockedBallastUsd += p.backing.lockedValueUsd;
    }
    if (p.ballasted) ballastedCount++;
  }

  return {
    isConfigured,
    isLoading,
    hasLaunches,
    launchesAllTime: count,
    ballastedCount,
    ballastedSharePct: count > 0 ? (ballastedCount / count) * 100 : undefined,
    totalBallastUsd,
    lockedBallastUsd,
    // Median backing ratio = median(market price ÷ backing per token) across
    // projects. It needs a MARKET price per project, which this build has no
    // on-chain quoter for (ProjectCard shows "price n/a"). Rather than fabricate
    // a 1.00×, we return null and the UI says plainly it needs a market source —
    // it lights up once pools/quoter or the indexer provide per-project price.
    medianBackingRatio: null,
  };
}
