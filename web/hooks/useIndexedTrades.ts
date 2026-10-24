"use client";

import { useQuery } from "@tanstack/react-query";

// Indexed recent trades for a token, from the Postgres indexer via /api/indexer/
// read/trades. `available=false` whenever the indexer is unconfigured/empty or the
// fetch fails, so the caller keeps its current data source (useTrades).

export type IndexedTrade = {
  side: "buy" | "sell";
  amountToken: number;
  amountQuote: number;
  price: number | null;
  usdSize: number | null;
  trader: string;
  ts: number; // unix seconds
  txHash: string;
};

export type IndexedTradesResult = {
  available: boolean;
  trades: IndexedTrade[];
  isLoading: boolean;
};

const EMPTY: IndexedTrade[] = [];

export function useIndexedTrades(token?: string, limit = 50): IndexedTradesResult {
  const q = useQuery<{ available: boolean; trades?: IndexedTrade[] }>({
    queryKey: ["indexed-trades", token?.toLowerCase(), limit],
    enabled: Boolean(token),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
    queryFn: async () => {
      try {
        const res = await fetch(`/api/indexer/read/trades?token=${token}&limit=${limit}`, { cache: "no-store" });
        if (!res.ok) return { available: false };
        return (await res.json()) as { available: boolean; trades?: IndexedTrade[] };
      } catch {
        return { available: false };
      }
    },
  });
  return {
    available: Boolean(q.data?.available),
    trades: q.data?.trades ?? EMPTY,
    isLoading: q.isLoading,
  };
}
