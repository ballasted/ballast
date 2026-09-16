"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { activeChain } from "@/lib/chain";

/** Current gas price, read live from the chain (not GeckoTerminal, not a
 *  guess) — one plain RPC call, cheap enough for the ticker bar's cadence. */
export function useGasPrice() {
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const q = useQuery<bigint>({
    queryKey: ["gas-price"],
    enabled: Boolean(publicClient),
    staleTime: 15_000,
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!publicClient) throw new Error("no client");
      return publicClient.getGasPrice();
    },
    retry: 1,
  });
  return { gasPriceWei: q.data, isLoading: q.isLoading, isError: q.isError };
}
