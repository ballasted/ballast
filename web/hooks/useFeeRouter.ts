"use client";

import { useEffect, useMemo, useState } from "react";
import { usePublicClient, useReadContracts } from "wagmi";
import { getAbiItem, type Address } from "viem";
import { feeRouterAbi, feeRouterFactoryAbi } from "@/lib/abis";
import { FEE_ROUTER_FACTORY_ADDRESS, isFeeRouterFactoryConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { backfillLogs } from "@/lib/eventBackfill";

const CHAIN_ID = activeChain.id;

/**
 * There is no on-chain registry mapping token -> FeeRouter (FeeRouterFactory is
 * deliberately stateless — see its contract-level note). The only way to find a
 * token's router is: scan every FeeRouterCreated event the factory has ever
 * emitted, then check each candidate router's own `token()` for a match. Volume
 * is low (one event per router ever deployed), so an unbounded fromBlock=0n scan
 * is fine — same posture as useLiveRail's getLogs usage, just without the 24h
 * window since a router can be arbitrarily old.
 */
function useFeeRouterCandidates() {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [candidates, setCandidates] = useState<Address[]>([]);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (!publicClient || !isFeeRouterFactoryConfigured || !FEE_ROUTER_FACTORY_ADDRESS) {
      setScanned(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const { logs } = await backfillLogs(publicClient, {
          address: FEE_ROUTER_FACTORY_ADDRESS,
          event: getAbiItem({ abi: feeRouterFactoryAbi, name: "FeeRouterCreated" }),
          fromBlock: 0n,
          toBlock: latest,
        });
        if (cancelled) return;
        const routers = logs
          .map((l) => (l as unknown as { args: { router?: Address } }).args.router)
          .filter((a): a is Address => Boolean(a));
        setCandidates(routers);
      } catch {
        /* leave candidates empty — the token page degrades to "no fee router" */
      } finally {
        if (!cancelled) setScanned(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  return { candidates, scanned };
}

/** Resolves the FeeRouter address for a token, or undefined if it has none. */
export function useFeeRouterAddress(token?: Address) {
  const { candidates, scanned } = useFeeRouterCandidates();

  const tokenRes = useReadContracts({
    allowFailure: true,
    contracts: candidates.map((r) => ({ address: r, abi: feeRouterAbi, functionName: "token", chainId: CHAIN_ID }) as const),
    query: { enabled: candidates.length > 0 },
  });

  const router = useMemo(() => {
    if (!token || candidates.length === 0) return undefined;
    for (let i = 0; i < candidates.length; i++) {
      const r = tokenRes.data?.[i];
      if (r?.status === "success" && (r.result as Address).toLowerCase() === token.toLowerCase()) {
        return candidates[i];
      }
    }
    return undefined;
  }, [candidates, tokenRes.data, token]);

  return {
    router,
    // Not-found (most tokens) must read as "done looking, nothing here", not
    // "still loading" — so isLoading is false once scanned even with 0 candidates.
    isLoading: !scanned || (candidates.length > 0 && tokenRes.isLoading),
  };
}

export type FeeRouterState = {
  address: Address;
  realCreator: Address;
  treasury: Address;
  stakingVault: Address;
  treasuryAsset: Address;
  buybackWired: boolean;
  pendingBuybackWeth: bigint;
  creatorBps: number;
  treasuryBps: number;
  buybackBps: number;
  rewardsBps: number;
  hasPendingSplit: boolean;
  pendingCreatorBps: number;
  pendingTreasuryBps: number;
  pendingBuybackBps: number;
  pendingRewardsBps: number;
  pendingEffectiveAt: bigint;
  readyAt: bigint;
  totalRoutedToCreator: bigint;
  totalRoutedToTreasury: bigint;
  totalTreasuryAssetDeposited: bigint;
  totalRoutedToBuyback: bigint;
  totalTokenBurned: bigint;
  totalRoutedToRewards: bigint;
};

const FIELDS = [
  "realCreator",
  "treasury",
  "stakingVault",
  "treasuryAsset",
  "buybackWired",
  "pendingBuybackWeth",
  "creatorBps",
  "treasuryBps",
  "buybackBps",
  "rewardsBps",
  "hasPendingSplit",
  "pendingCreatorBps",
  "pendingTreasuryBps",
  "pendingBuybackBps",
  "pendingRewardsBps",
  "pendingEffectiveAt",
  "readyAt",
  "totalRoutedToCreator",
  "totalRoutedToTreasury",
  "totalTreasuryAssetDeposited",
  "totalRoutedToBuyback",
  "totalTokenBurned",
  "totalRoutedToRewards",
] as const;

/** Full live state for a token's FeeRouter, or `state: undefined` if it has none
 *  (the normal case — render nothing, not an empty/error state, per CLAUDE.md). */
export function useFeeRouter(token?: Address) {
  const { router, isLoading: isResolving } = useFeeRouterAddress(token);

  const res = useReadContracts({
    allowFailure: true,
    contracts: router
      ? FIELDS.map((fn) => ({ address: router, abi: feeRouterAbi, functionName: fn, chainId: CHAIN_ID }) as const)
      : [],
    query: liveQuery(Boolean(router)),
  });

  const state: FeeRouterState | undefined = useMemo(() => {
    if (!router || !res.data) return undefined;
    const pick = (i: number) => (res.data![i]?.status === "success" ? res.data![i]!.result : undefined);
    const realCreator = pick(0) as Address | undefined;
    if (!realCreator) return undefined; // a read failed — treat as not-yet-loaded, not "no router"
    return {
      address: router,
      realCreator,
      treasury: pick(1) as Address,
      stakingVault: pick(2) as Address,
      treasuryAsset: pick(3) as Address,
      buybackWired: Boolean(pick(4)),
      pendingBuybackWeth: pick(5) as bigint,
      creatorBps: Number(pick(6)),
      treasuryBps: Number(pick(7)),
      buybackBps: Number(pick(8)),
      rewardsBps: Number(pick(9)),
      hasPendingSplit: Boolean(pick(10)),
      pendingCreatorBps: Number(pick(11)),
      pendingTreasuryBps: Number(pick(12)),
      pendingBuybackBps: Number(pick(13)),
      pendingRewardsBps: Number(pick(14)),
      pendingEffectiveAt: pick(15) as bigint,
      readyAt: pick(16) as bigint,
      totalRoutedToCreator: pick(17) as bigint,
      totalRoutedToTreasury: pick(18) as bigint,
      totalTreasuryAssetDeposited: pick(19) as bigint,
      totalRoutedToBuyback: pick(20) as bigint,
      totalTokenBurned: pick(21) as bigint,
      totalRoutedToRewards: pick(22) as bigint,
    };
  }, [router, res.data]);

  return {
    router,
    state,
    isLoading: isResolving || (Boolean(router) && res.isLoading),
    refetch: res.refetch,
  };
}
