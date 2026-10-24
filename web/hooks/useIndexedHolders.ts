"use client";

import { useQuery } from "@tanstack/react-query";

// Indexed holder distribution for a token, from the Postgres indexer via
// /api/indexer/read/holders. `available=false` whenever the indexer is
// unconfigured/empty or the fetch fails, so the caller keeps its current source
// (useHolders / Blockscout).

export type IndexedHolder = { holder: string; balance: number };

export type IndexedHoldersResult = {
  available: boolean;
  holders: IndexedHolder[];
  count: number;
  isLoading: boolean;
};

const EMPTY: IndexedHolder[] = [];

export function useIndexedHolders(token?: string, limit = 100): IndexedHoldersResult {
  const q = useQuery<{ available: boolean; holders?: IndexedHolder[]; count?: number }>({
    queryKey: ["indexed-holders", token?.toLowerCase(), limit],
    enabled: Boolean(token),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      try {
        const res = await fetch(`/api/indexer/read/holders?token=${token}&limit=${limit}`, { cache: "no-store" });
        if (!res.ok) return { available: false };
        return (await res.json()) as { available: boolean; holders?: IndexedHolder[]; count?: number };
      } catch {
        return { available: false };
      }
    },
  });
  return {
    available: Boolean(q.data?.available),
    holders: q.data?.holders ?? EMPTY,
    count: q.data?.count ?? 0,
    isLoading: q.isLoading,
  };
}
