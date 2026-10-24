"use client";

import { useQuery } from "@tanstack/react-query";

// Indexed protocol-wide Discover stats + daily analytics series, from the Postgres
// indexer. `available=false` whenever the indexer is unconfigured/empty or the
// fetch fails, so callers keep their current sources (useProtocolStats /
// useAnalyticsSeries).

export type IndexedDiscoverStats = {
  launchesTotal: number;
  tradesTotal: number;
  volumeUsdAll: number;
  volume24hUsd: number;
  trades24h: number;
};

export type IndexedStatsResult = {
  available: boolean;
  stats?: IndexedDiscoverStats;
  isLoading: boolean;
};

export function useIndexedStats(): IndexedStatsResult {
  const q = useQuery<{ available: boolean; stats?: IndexedDiscoverStats }>({
    queryKey: ["indexed-stats"],
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      try {
        const res = await fetch(`/api/indexer/read/stats`, { cache: "no-store" });
        if (!res.ok) return { available: false };
        return (await res.json()) as { available: boolean; stats?: IndexedDiscoverStats };
      } catch {
        return { available: false };
      }
    },
  });
  return { available: Boolean(q.data?.available), stats: q.data?.stats, isLoading: q.isLoading };
}

export type IndexedAnalyticsDay = {
  day: string;
  volumeUsd: number;
  trades: number;
  launches: number;
  burnedTokens: number;
};

export type IndexedAnalyticsResult = {
  available: boolean;
  days: IndexedAnalyticsDay[];
  isLoading: boolean;
};

const EMPTY_DAYS: IndexedAnalyticsDay[] = [];

export function useIndexedAnalytics(days = 30): IndexedAnalyticsResult {
  const q = useQuery<{ available: boolean; days?: IndexedAnalyticsDay[] }>({
    queryKey: ["indexed-analytics", days],
    refetchInterval: 120_000,
    staleTime: 120_000,
    retry: 1,
    queryFn: async () => {
      try {
        const res = await fetch(`/api/indexer/read/analytics?days=${days}`, { cache: "no-store" });
        if (!res.ok) return { available: false };
        return (await res.json()) as { available: boolean; days?: IndexedAnalyticsDay[] };
      } catch {
        return { available: false };
      }
    },
  });
  return { available: Boolean(q.data?.available), days: q.data?.days ?? EMPTY_DAYS, isLoading: q.isLoading };
}
