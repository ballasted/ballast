"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { VerificationResult } from "@/app/api/verify/[address]/route";

// Client hook for a token's live verification checks — /api/verify/[address].
// Refetches on an interval well under the route's own 30s cache so the panel
// never quietly goes stale while the tab is open.
export function useVerification(token?: Address) {
  const q = useQuery<VerificationResult>({
    queryKey: ["verify", token?.toLowerCase()],
    enabled: Boolean(token),
    staleTime: 20_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<VerificationResult> => {
      const res = await fetch(`/api/verify/${token}`, { cache: "no-store" });
      return (await res.json()) as VerificationResult;
    },
    retry: 1,
  });
  return { data: q.data, isLoading: q.isLoading, isError: q.isError };
}
