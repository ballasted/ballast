"use client";

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { backingLensAbi, projectTreasuryAbi, erc20Abi } from "@/lib/abis";
import { LENS_ADDRESS, isLensConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import type { ProjectBacking } from "./useProjects";

const CHAIN_ID = activeChain.id;

export type PendingWithdrawal = {
  id: bigint;
  asset: Address;
  amount: bigint;
  unlockAt: bigint;
};

export function useBacking(treasury?: Address) {
  const enabled = isLensConfigured && Boolean(treasury);

  const stage1 = useReadContracts({
    allowFailure: true,
    contracts: treasury
      ? [
          { address: LENS_ADDRESS!, abi: backingLensAbi, functionName: "backingOf", args: [treasury], chainId: CHAIN_ID } as const,
          { address: treasury, abi: projectTreasuryAbi, functionName: "projectToken", chainId: CHAIN_ID } as const,
          { address: treasury, abi: projectTreasuryAbi, functionName: "pendingWithdrawal", chainId: CHAIN_ID } as const,
          { address: treasury, abi: projectTreasuryAbi, functionName: "noticePeriod", chainId: CHAIN_ID } as const,
        ]
      : [],
    query: { enabled },
  });

  const backing =
    stage1.data?.[0]?.status === "success"
      ? (stage1.data[0].result as unknown as ProjectBacking)
      : undefined;
  const token = stage1.data?.[1]?.status === "success" ? (stage1.data[1].result as Address) : undefined;

  let pending: PendingWithdrawal | undefined;
  const pw = stage1.data?.[2];
  if (pw?.status === "success") {
    const [id, asset, amount, unlockAt] = pw.result as unknown as [bigint, Address, bigint, bigint];
    if (id > 0n) pending = { id, asset, amount, unlockAt };
  }
  const noticePeriod = stage1.data?.[3]?.status === "success" ? (stage1.data[3].result as bigint) : undefined;

  const stage2 = useReadContracts({
    allowFailure: true,
    contracts: token
      ? [
          { address: token, abi: erc20Abi, functionName: "name", chainId: CHAIN_ID } as const,
          { address: token, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID } as const,
        ]
      : [],
    query: { enabled: Boolean(token) },
  });

  return {
    backing,
    token,
    name: stage2.data?.[0]?.status === "success" ? (stage2.data[0].result as string) : undefined,
    symbol: stage2.data?.[1]?.status === "success" ? (stage2.data[1].result as string) : undefined,
    pending,
    noticePeriod,
    isConfigured: isLensConfigured,
    isLoading: stage1.isLoading || stage2.isLoading,
    found: Boolean(backing),
  };
}
