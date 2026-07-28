"use client";

import { useQuery } from "@tanstack/react-query";
import type { TrendingData } from "@/lib/market";

// Client hook for the trending ranking, from our /api/trending proxy. Returns a
// ranked list of token addresses + per-token 24h metrics, a `thin` flag when
// there's too little activity to rank honestly, and available:false on failure.
export function useTrending() {
  const q = useQuery<TrendingData>({
    queryKey: ["trending"],
    staleTime: 60_000,
    refetchInterval: 90_000,
    queryFn: async (): Promise<TrendingData> => {
      try {
        const res = await fetch(`/api/trending`, { cache: "no-store" });
        return (await res.json()) as TrendingData;
      } catch {
        return { available: false, source: "GeckoTerminal", thin: true, items: [] };
      }
    },
    retry: 1,
  });
  return { data: q.data, isLoading: q.isLoading, available: Boolean(q.data?.available) };
}
