"use client";

import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { backingLensAbi, erc20Abi, ballastFactoryAbi } from "@/lib/abis";
import {
  LENS_ADDRESS,
  FACTORY_ADDRESS,
  isLensConfigured,
  isFactoryConfigured,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;

export type ProjectBacking = {
  sequencerStatus: number; // 0 Unknown, 1 Up, 2 GracePeriod, 3 Down
  totalSupply: bigint;
  lockedValueUsd: bigint;
  withdrawableValueUsd: bigint;
  totalValueUsd: bigint;
  backingPerToken: bigint;
  lockedBackingPerToken: bigint;
  anyStale: boolean;
  anyUnpriced: boolean;
  assets: readonly unknown[];
};

export type Project = {
  treasury: Address;
  token: Address;
  creator: Address;
  name?: string;
  symbol?: string;
  backing?: ProjectBacking;
  ballasted: boolean; // has any backing value
};

/**
 * Enumerates every launch from the BallastFactory registry (launchCount +
 * launches[i]) — the ONLY per-launch address source — then reads each treasury's
 * backing through BackingLens and the token name/symbol, all batched via
 * multicall. No env address list: Discover is the registry, live.
 */
export function useProjects() {
  const countRes = useReadContract({
    address: FACTORY_ADDRESS,
    abi: ballastFactoryAbi,
    functionName: "launchCount",
    chainId: CHAIN_ID,
    query: { enabled: isFactoryConfigured },
  });
  const count = countRes.data ? Number(countRes.data) : 0;

  // Registry rows: launches[0..count-1] => {token, treasury, creator}.
  const rowsRes = useReadContracts({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, i) => ({
      address: FACTORY_ADDRESS!,
      abi: ballastFactoryAbi,
      functionName: "launches",
      args: [BigInt(i)],
      chainId: CHAIN_ID,
    })),
    query: { enabled: isFactoryConfigured && count > 0 },
  });

  const rows = (rowsRes.data ?? []).map((r) =>
    r?.status === "success"
      ? (r.result as unknown as readonly [Address, Address, Address])
      : undefined,
  );

  // backingOf(treasury) + token name/symbol for each launch.
  const dataRes = useReadContracts({
    allowFailure: true,
    contracts: rows.flatMap((row) =>
      row
        ? [
            {
              address: LENS_ADDRESS!,
              abi: backingLensAbi,
              functionName: "backingOf",
              args: [row[1]],
              chainId: CHAIN_ID,
            } as const,
            {
              address: row[0],
              abi: erc20Abi,
              functionName: "name",
              chainId: CHAIN_ID,
            } as const,
            {
              address: row[0],
              abi: erc20Abi,
              functionName: "symbol",
              chainId: CHAIN_ID,
            } as const,
          ]
        : [],
    ),
    query: { enabled: isLensConfigured && rows.some(Boolean) },
  });

  const projects: Project[] = [];
  let cursor = 0;
  for (const row of rows) {
    if (!row) continue;
    const [token, treasury, creator] = row;
    const b = dataRes.data?.[cursor];
    const nm = dataRes.data?.[cursor + 1];
    const sy = dataRes.data?.[cursor + 2];
    cursor += 3;
    const backing =
      b?.status === "success" ? (b.result as unknown as ProjectBacking) : undefined;
    projects.push({
      token,
      treasury,
      creator,
      name: nm?.status === "success" ? (nm.result as string) : undefined,
      symbol: sy?.status === "success" ? (sy.result as string) : undefined,
      backing,
      ballasted: Boolean(backing && backing.totalValueUsd > 0n),
    });
  }

  return {
    projects,
    isLoading:
      countRes.isLoading || rowsRes.isLoading || (rows.some(Boolean) && dataRes.isLoading),
    isConfigured: isLensConfigured && isFactoryConfigured,
    hasLaunches: count > 0,
    count,
    error: countRes.error ?? rowsRes.error,
  };
}
