"use client";

import { useQuery } from "@tanstack/react-query";

// Protocol time-series analytics, from our /api/analytics proxy (GeckoTerminal),
// NOT a Ponder indexer (deferred indefinitely — see docs/BALLAST-build-spec.md).
// Only what GeckoTerminal can honestly supply lives here: 24h volume, 24h trades,
// and a daily-volume series. It NEVER degrades to a stale or zero value — on any
// failure the whole series is marked unavailable with a reason and the UI says so.
// Protocol totals (ballast, launches, share) come from chain via useProtocolStats.
export type DayBar = { day: string; volumeUsd: number };

export type AnalyticsSeries = {
  available: boolean;
  reason?: "unreachable";
  fetchedAt?: number;
  volume24hUsd?: number;
  volumePrev24hUsd?: number; // prior day, for a real day-over-day delta
  trades24h?: number;
  daily: DayBar[];
  isLoading?: boolean; // first-load flag, so a stats card can skeleton vs. degrade
};

const EMPTY: DayBar[] = [];

export function useAnalyticsSeries(): AnalyticsSeries {
  const q = useQuery<AnalyticsSeries>({
    queryKey: ["analytics-series"],
    refetchInterval: 120_000,
    staleTime: 120_000,
    queryFn: async (): Promise<AnalyticsSeries> => {
      try {
        const res = await fetch("/api/analytics", { cache: "no-store" });
        const json = (await res.json()) as AnalyticsSeries;
        return { ...json, daily: json.daily ?? EMPTY };
      } catch {
        return { available: false, reason: "unreachable", daily: EMPTY };
      }
    },
    retry: 1,
  });

  return { ...(q.data ?? { available: false, reason: "unreachable", daily: EMPTY }), isLoading: q.isLoading };
}
