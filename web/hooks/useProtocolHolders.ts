"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { ProtocolHoldersData } from "@/app/api/holders/summary/route";

// Protocol-wide unique holders across our tokens, via the /api/holders/summary
// proxy (Blockscout). Degrades to available:false on any failure so the stats card
// shows "unavailable", never a fabricated or zero count. Keyed by the sorted token
// set so it reconciles with whatever Discover currently lists.
export function useProtocolHolders(tokens: Address[]) {
  const key = tokens.map((t) => t.toLowerCase()).sort().join(",");
  const q = useQuery<ProtocolHoldersData>({
    queryKey: ["protocol-holders", key],
    enabled: tokens.length > 0,
    staleTime: 45_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ProtocolHoldersData> => {
      try {
        const res = await fetch(`/api/holders/summary?tokens=${key}`, { cache: "no-store" });
        return (await res.json()) as ProtocolHoldersData;
      } catch {
        return { available: false, source: "Blockscout", reason: "unreachable" };
      }
    },
    retry: 1,
  });
  return { data: q.data ?? { available: false, source: "Blockscout" }, isLoading: q.isLoading };
}
