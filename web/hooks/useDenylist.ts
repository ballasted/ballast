"use client";

import { useMemo } from "react";
import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { METADATA_DENYLIST_ADDRESS, isDenylistConfigured } from "@/lib/contracts";
import { metadataDenylistAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;

// The owner-managed metadata denylist, read live from chain. DEFAULT-ALLOW: if the
// contract isn't configured, or the read hasn't landed, or it fails, nothing is
// suppressed — a missing/failed read can never hide a token, only ever fail open.
//
// One read of the whole denied set powers the Discover board (membership test);
// useDenylistEntry reads a single token's full record (state + reason) for the
// withheld notice on its page.
export function useDenylist() {
  const { data } = useReadContract({
    address: METADATA_DENYLIST_ADDRESS,
    abi: metadataDenylistAbi,
    functionName: "deniedTokens",
    chainId: CHAIN_ID,
    query: { enabled: isDenylistConfigured, staleTime: 60_000, refetchInterval: 60_000 },
  });
  const set = useMemo(
    () => new Set(((data as readonly Address[] | undefined) ?? []).map((a) => a.toLowerCase())),
    [data],
  );
  return {
    isDenied: (token?: string): boolean => (token ? set.has(token.toLowerCase()) : false),
  };
}

export function useDenylistEntry(token?: Address) {
  const { data } = useReadContract({
    address: METADATA_DENYLIST_ADDRESS,
    abi: metadataDenylistAbi,
    functionName: "entryOf",
    args: token ? [token] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: isDenylistConfigured && Boolean(token), staleTime: 60_000 },
  });
  const [denied, updatedAt, reason] =
    (data as readonly [boolean, bigint, string] | undefined) ?? [false, 0n, ""];
  return { denied, updatedAt: Number(updatedAt), reason };
}
