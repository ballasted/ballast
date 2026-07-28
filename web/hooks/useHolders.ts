"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { HoldersData } from "@/lib/blockscout";

// Client hook for a token's holders, fetched from our /api/holders proxy (which
// talks to Blockscout). Returns HoldersData; degrades to available:false on any
// failure so the UI shows an honest state, never a fabricated or stale count.
export function useHolders(token?: Address) {
  const q = useQuery<HoldersData>({
    queryKey: ["holders", token?.toLowerCase()],
    enabled: Boolean(token),
    staleTime: 45_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<HoldersData> => {
      try {
        const res = await fetch(`/api/holders?token=${token}`, { cache: "no-store" });
        return (await res.json()) as HoldersData;
      } catch {
        return { available: false, source: "Blockscout", reason: "unreachable", holders: [] };
      }
    },
    retry: 1,
  });
  return { holders: q.data, isLoading: q.isLoading, available: Boolean(q.data?.available) };
}
