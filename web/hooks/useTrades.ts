"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { TradesData } from "@/lib/market";

// Client hook for a token's recent trades, from our /api/trades proxy (GeckoTerminal).
// Degrades to available:false on any failure so the feed shows an honest state.
export function useTrades(token?: Address) {
  const q = useQuery<TradesData>({
    queryKey: ["trades", token?.toLowerCase()],
    enabled: Boolean(token),
    staleTime: 30_000,
    refetchInterval: 45_000,
    queryFn: async (): Promise<TradesData> => {
      try {
        const res = await fetch(`/api/trades?token=${token}`, { cache: "no-store" });
        return (await res.json()) as TradesData;
      } catch {
        return { available: false, source: "GeckoTerminal", reason: "unreachable", trades: [] };
      }
    },
    retry: 1,
  });
  return { data: q.data, isLoading: q.isLoading, available: Boolean(q.data?.available) };
}
