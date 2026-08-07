"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { OhlcvData, Timeframe } from "@/lib/market";
import { DEFAULT_TIMEFRAME } from "@/lib/market";

// Client hook for candlestick data, fetched from our /api/ohlcv proxy (which talks to
// GeckoTerminal). Mirrors useMarket: degrades to available:false on any failure so the
// chart shows an honest "no market data" state, never a fabricated series. Keyed by
// token + timeframe so switching timeframe swaps the cached series cleanly.
export function useOhlcv(token?: Address, tf: Timeframe = DEFAULT_TIMEFRAME) {
  const q = useQuery<OhlcvData>({
    queryKey: ["ohlcv", token?.toLowerCase(), tf],
    enabled: Boolean(token),
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev, // keep the last series on screen while a new tf loads
    queryFn: async (): Promise<OhlcvData> => {
      try {
        const res = await fetch(`/api/ohlcv?token=${token}&tf=${tf}`, { cache: "no-store" });
        return (await res.json()) as OhlcvData;
      } catch {
        return { available: false, source: "GeckoTerminal", reason: "unreachable", timeframe: tf, candles: [] };
      }
    },
    retry: 1,
  });
  return { ohlcv: q.data, isLoading: q.isLoading, available: Boolean(q.data?.available) };
}
