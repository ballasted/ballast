"use client";

import { useEffect, useState } from "react";
import { useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Log } from "viem";
import { ramsesLockerAbi, ramsesLockLauncherAbi, ballastFeeSplitterAbi } from "@/lib/abis";
import { RAMSES_LOCKER_ADDRESS, RAMSES_LAUNCHER_ADDRESS, isRamsesEnabled } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";

const CHAIN_ID = activeChain.id;

type CreatedAndLockedLog = Log & {
  args: {
    tokenId: bigint;
    splitter: Address;
    launchedToken: Address;
    token0: Address;
    token1: Address;
    amount0: bigint;
    amount1: bigint;
    creatorRecipient: Address;
    creatorBps: number;
    protocolBps: number;
  };
};

export type RamsesPosition = {
  tokenId: bigint;
  splitter: Address;
  token0: Address;
  token1: Address;
  creatorRecipient: Address;
  creatorBps: number;
  protocolBps: number;
};

/**
 * Discovers whether `token` has an associated Ramses-locked position by
 * scanning RamsesLockLauncher's own CreatedAndLocked event (indexed by
 * `launchedToken`) — the launcher is deliberately stateless (no owner, no
 * mapping), so this event IS the only discovery path, same reasoning as
 * other event-sourced lookups in this app (no indexer — Ponder deferred).
 * Renders/resolves nothing when `isRamsesEnabled` is false.
 */
export function useRamsesPosition(token?: Address) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const enabled = isRamsesEnabled && Boolean(token);
  const [position, setPosition] = useState<RamsesPosition>();
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "failed">("idle");

  useEffect(() => {
    if (!enabled || !publicClient || !token || !RAMSES_LAUNCHER_ADDRESS) {
      setStatus("idle");
      setPosition(undefined);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const logs = (await publicClient.getLogs({
          address: RAMSES_LAUNCHER_ADDRESS,
          event: getAbiItem({ abi: ramsesLockLauncherAbi, name: "CreatedAndLocked" }),
          args: { launchedToken: token },
          fromBlock: 0n,
          toBlock: "latest",
        })) as CreatedAndLockedLog[];
        if (cancelled) return;
        // A token could in principle back multiple positions over time (e.g. a
        // creator adding more later) — show the most recent one.
        const latest = logs.sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)))[0];
        setPosition(
          latest
            ? {
                tokenId: latest.args.tokenId,
                splitter: latest.args.splitter,
                token0: latest.args.token0,
                token1: latest.args.token1,
                creatorRecipient: latest.args.creatorRecipient,
                creatorBps: latest.args.creatorBps,
                protocolBps: latest.args.protocolBps,
              }
            : undefined,
        );
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, publicClient, token]);

  const pendingFeesRes = useReadContract({
    address: RAMSES_LOCKER_ADDRESS,
    abi: ramsesLockerAbi,
    functionName: "pendingFees",
    args: position ? [position.tokenId] : undefined,
    chainId: CHAIN_ID,
    query: liveQuery(Boolean(position)),
  });
  const pendingFees = pendingFeesRes.data as readonly [bigint, bigint] | undefined;

  const splitterRes = useReadContracts({
    contracts: position
      ? ([
          { address: position.splitter, abi: ballastFeeSplitterAbi, functionName: "protocolRecipient", chainId: CHAIN_ID },
        ] as const)
      : [],
    query: liveQuery(Boolean(position)),
  });
  const protocolRecipient = splitterRes.data?.[0]?.result as Address | undefined;

  return {
    enabled,
    status,
    position,
    pendingFees0: pendingFees?.[0],
    pendingFees1: pendingFees?.[1],
    protocolRecipient,
    refetch: () => {
      void pendingFeesRes.refetch();
      void splitterRes.refetch();
    },
  };
}
