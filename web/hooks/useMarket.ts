"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { MarketData } from "@/lib/market";

// Client hook for external market data, fetched from our /api/market proxy (which
// talks to GeckoTerminal). Returns MarketData; degrades to available:false on any
// failure so the UI shows an honest state, never a fabricated price (Part E).
export function useMarket(token?: Address) {
  const q = useQuery<MarketData>({
    queryKey: ["market", token?.toLowerCase()],
    enabled: Boolean(token),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/market?token=${token}`, { cache: "no-store" });
      // The route always returns a MarketData shape, even on error status.
      return (await res.json()) as MarketData;
    },
  });
  return {
    market: q.data,
    isLoading: q.isLoading,
    available: Boolean(q.data?.available),
  };
}
