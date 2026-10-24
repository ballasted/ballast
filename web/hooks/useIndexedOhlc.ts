"use client";

import { useQuery } from "@tanstack/react-query";

// Indexed OHLC candles for a token/bucket, from the Postgres indexer via
// /api/indexer/read/ohlc. `available=false` whenever the indexer is
// unconfigured/empty or the fetch fails, so the caller keeps its current source
// (useOhlcv / GeckoTerminal).

export type IndexedBucket = "1m" | "5m" | "1h" | "4h" | "1D";

export type IndexedCandle = {
  ts: number; // unix seconds (bucket start)
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

export type IndexedOhlcResult = {
  available: boolean;
  candles: IndexedCandle[];
  isLoading: boolean;
};

const EMPTY: IndexedCandle[] = [];

export function useIndexedOhlc(token?: string, bucket: IndexedBucket = "1h", limit = 1000): IndexedOhlcResult {
  const q = useQuery<{ available: boolean; candles?: IndexedCandle[] }>({
    queryKey: ["indexed-ohlc", token?.toLowerCase(), bucket, limit],
    enabled: Boolean(token),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      try {
        const res = await fetch(`/api/indexer/read/ohlc?token=${token}&bucket=${bucket}&limit=${limit}`, {
          cache: "no-store",
        });
        if (!res.ok) return { available: false };
        return (await res.json()) as { available: boolean; candles?: IndexedCandle[] };
      } catch {
        return { available: false };
      }
    },
  });
  return {
    available: Boolean(q.data?.available),
    candles: q.data?.candles ?? EMPTY,
    isLoading: q.isLoading,
  };
}
