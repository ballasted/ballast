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
    // Never throw: the /api/market proxy always returns a MarketData shape, but a
    // transport-level failure (the proxy unreachable, request aborted, an HTML
    // error page) makes fetch/res.json() reject with `TypeError: Failed to fetch`.
    // Left unhandled that surfaces as a console error and a red query; instead we
    // degrade to an honest available:false so the panel shows "unreachable".
    queryFn: async (): Promise<MarketData> => {
      try {
        const res = await fetch(`/api/market?token=${token}`, { cache: "no-store" });
        return (await res.json()) as MarketData;
      } catch {
        return { available: false, source: "GeckoTerminal", reason: "unreachable", pools: [] };
      }
    },
    retry: 1,
  });
  return {
    market: q.data,
    isLoading: q.isLoading,
    available: Boolean(q.data?.available),
  };
}
