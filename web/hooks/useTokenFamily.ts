"use client";

import { useEffect, useMemo, useState } from "react";
import { usePublicClient, useReadContracts } from "wagmi";
import { getAbiItem, type Address } from "viem";
import { feeRouterV2Abi, feeRouterFactoryV2Abi } from "@/lib/abis";
import { FEE_ROUTER_FACTORIES } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { backfillLogs } from "@/lib/eventBackfill";

const CHAIN_ID = activeChain.id;
const ZERO = "0x0000000000000000000000000000000000000000";

/** Every v2 FeeRouter ever created (families only exist on v2). */
function useV2Routers() {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [routers, setRouters] = useState<Address[]>([]);
  const [scanned, setScanned] = useState(false);
  const v2Factories = useMemo(() => FEE_ROUTER_FACTORIES.filter((f) => f.version === 2), []);

  useEffect(() => {
    if (!publicClient || v2Factories.length === 0) {
      setScanned(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const per = await Promise.all(
          v2Factories.map((f) =>
            backfillLogs(publicClient, {
              address: f.address,
              event: getAbiItem({ abi: feeRouterFactoryV2Abi, name: "FeeRouterCreated" }),
              fromBlock: 0n,
              toBlock: latest,
            }).then((res) =>
              res.logs
                .map((l) => (l as unknown as { args: { router?: Address } }).args.router)
                .filter((a): a is Address => Boolean(a)),
            ),
          ),
        );
        if (!cancelled) setRouters(per.flat());
      } catch {
        /* degrade to no family info */
      } finally {
        if (!cancelled) setScanned(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, v2Factories]);

  return { routers, scanned };
}

export type TokenFamily = {
  /** Child routers whose `parent` is this token, with how much of this token each burned. */
  children: { router: Address; childToken: Address; burned: bigint }[];
  childCount: number;
  totalBurnedByChildren: bigint;
};

/**
 * The family picture FROM A PARENT'S SIDE: every v2 router that named `token` as
 * its parent, and the running total of `token` those children have bought-and-
 * burned (summed from each child router's totalParentBurned). Returns an empty
 * family for a token with no children. The child's own "Child of $X" badge is read
 * directly off its router state (useFeeRouter().state.parent) — no scan needed.
 */
export function useTokenFamily(token?: Address): { family: TokenFamily; isLoading: boolean } {
  const { routers, scanned } = useV2Routers();

  const res = useReadContracts({
    allowFailure: true,
    contracts: routers.flatMap(
      (r) =>
        [
          { address: r, abi: feeRouterV2Abi, functionName: "parent", chainId: CHAIN_ID },
          { address: r, abi: feeRouterV2Abi, functionName: "token", chainId: CHAIN_ID },
          { address: r, abi: feeRouterV2Abi, functionName: "totalParentBurned", chainId: CHAIN_ID },
        ] as const,
    ),
    query: liveQuery(routers.length > 0),
  });

  const family: TokenFamily = useMemo(() => {
    const children: TokenFamily["children"] = [];
    if (!token || !res.data) return { children, childCount: 0, totalBurnedByChildren: 0n };
    const want = token.toLowerCase();
    for (let i = 0; i < routers.length; i++) {
      const parent = res.data[i * 3]?.status === "success" ? (res.data[i * 3]!.result as Address) : undefined;
      if (!parent || parent.toLowerCase() === ZERO || parent.toLowerCase() !== want) continue;
      const childToken = res.data[i * 3 + 1]?.status === "success" ? (res.data[i * 3 + 1]!.result as Address) : undefined;
      const burned = res.data[i * 3 + 2]?.status === "success" ? (res.data[i * 3 + 2]!.result as bigint) : 0n;
      if (childToken) children.push({ router: routers[i]!, childToken, burned });
    }
    const totalBurnedByChildren = children.reduce((s, c) => s + c.burned, 0n);
    return { children, childCount: children.length, totalBurnedByChildren };
  }, [token, res.data, routers]);

  return { family, isLoading: !scanned || (routers.length > 0 && res.isLoading) };
}
