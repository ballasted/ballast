"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

// Returns a callback that forces every live query to refetch NOW. Call it right
// after a user's transaction confirms (swap, claim, launch, graduate) so their own
// price / backing / fees / holdings reflect the new chain state immediately instead
// of waiting up to 12s for the next poll (spec Part 1.2: "immediately after any
// transaction the user sends").
//
// Broad by design: a confirmed tx is a rare, user-initiated moment, and a swap can
// legitimately move several figures at once (price, backing ratio, the trades feed,
// volume), so invalidating everything is correct rather than wasteful here. The IPFS
// metadata fetch is a manual effect + module cache (not React-Query), so it is
// untouched by this.
export function useInvalidateChainReads() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);
}
