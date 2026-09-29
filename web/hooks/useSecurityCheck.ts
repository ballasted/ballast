"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { SecurityCheckApiResponse } from "@/app/api/security-check/route";

// Client hook for one or more tokens' live GoPlus security check, fetched from
// our /api/security-check proxy (never GoPlus directly — see that route for why).
// A stable, sorted, deduped key means a component re-rendering with the same
// token set (e.g. the dashboard re-rendering on every project-list refresh)
// reuses the same cache entry rather than refetching.
export function useSecurityChecks(tokens: Address[]) {
  const key = [...new Set(tokens.map((t) => t.toLowerCase()))].sort().join(",");
  const q = useQuery<SecurityCheckApiResponse>({
    queryKey: ["security-check", key],
    enabled: key.length > 0,
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async (): Promise<SecurityCheckApiResponse> => {
      try {
        const res = await fetch(`/api/security-check?tokens=${encodeURIComponent(key)}`, { cache: "no-store" });
        return (await res.json()) as SecurityCheckApiResponse;
      } catch {
        return { fetchedAt: Math.floor(Date.now() / 1000), source: "GoPlus", available: false, reason: "unreachable", results: {} };
      }
    },
    retry: 1,
  });
  return { data: q.data, isLoading: q.isLoading };
}

export function useSecurityCheck(token?: Address) {
  const { data, isLoading } = useSecurityChecks(token ? [token] : []);
  const result = token ? data?.results[token.toLowerCase()] : undefined;
  return { data, result, isLoading };
}
