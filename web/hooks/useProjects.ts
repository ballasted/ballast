"use client";

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { backingLensAbi, projectTreasuryAbi, erc20Abi } from "@/lib/abis";
import { LENS_ADDRESS, DISCOVER_TREASURIES, isLensConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;

export type ProjectBacking = {
  sequencerUp: boolean;
  sequencerGraceActive: boolean;
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
  token?: Address;
  name?: string;
  symbol?: string;
  backing?: ProjectBacking;
  ballasted: boolean; // has any backing value
};

/**
 * Reads every configured treasury through BackingLens (backingOf) plus its token
 * name/symbol, batched via multicall. This is the real wiring to BackingLens;
 * the treasury LIST is temporary (env) until the factory registry / indexer ships.
 */
export function useProjects() {
  const treasuries = DISCOVER_TREASURIES;

  // Stage 1: backingOf + projectToken for each treasury.
  const stage1 = useReadContracts({
    allowFailure: true,
    contracts: treasuries.flatMap((t) => [
      { address: LENS_ADDRESS!, abi: backingLensAbi, functionName: "backingOf", args: [t], chainId: CHAIN_ID } as const,
      { address: t, abi: projectTreasuryAbi, functionName: "projectToken", chainId: CHAIN_ID } as const,
    ]),
    query: { enabled: isLensConfigured && treasuries.length > 0 },
  });

  const tokenAddrs: Array<Address | undefined> = treasuries.map((_, i) => {
    const res = stage1.data?.[i * 2 + 1];
    return res?.status === "success" ? (res.result as Address) : undefined;
  });

  // Stage 2: token name + symbol.
  const stage2 = useReadContracts({
    allowFailure: true,
    contracts: tokenAddrs.flatMap((addr) =>
      addr
        ? [
            { address: addr, abi: erc20Abi, functionName: "name", chainId: CHAIN_ID } as const,
            { address: addr, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID } as const,
          ]
        : [],
    ),
    query: { enabled: tokenAddrs.some(Boolean) },
  });

  const projects: Project[] = treasuries.map((treasury, i) => {
    const backingRes = stage1.data?.[i * 2];
    const backing =
      backingRes?.status === "success"
        ? (backingRes.result as unknown as ProjectBacking)
        : undefined;
    const token = tokenAddrs[i];

    // stage2 packs 2 entries per defined token, in order.
    const definedBefore = tokenAddrs.slice(0, i).filter(Boolean).length;
    const nameRes = token ? stage2.data?.[definedBefore * 2] : undefined;
    const symRes = token ? stage2.data?.[definedBefore * 2 + 1] : undefined;

    return {
      treasury,
      token,
      name: nameRes?.status === "success" ? (nameRes.result as string) : undefined,
      symbol: symRes?.status === "success" ? (symRes.result as string) : undefined,
      backing,
      ballasted: Boolean(backing && backing.totalValueUsd > 0n),
    };
  });

  return {
    projects,
    isLoading: stage1.isLoading || stage2.isLoading,
    isConfigured: isLensConfigured,
    hasTreasuries: treasuries.length > 0,
    error: stage1.error,
  };
}
