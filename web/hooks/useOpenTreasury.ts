"use client";

import { useAccount, useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { openTreasuryVaultFactoryAbi, openTreasuryVaultAbi, openTreasuryLensAbi } from "@/lib/abis";
import { OPEN_TREASURY_FACTORY_ADDRESS, OPEN_TREASURY_LENS_ADDRESS, isOpenTreasuryEnabled } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import type { AllowedAsset } from "@/hooks/useAssets";

const CHAIN_ID = activeChain.id;

export type CommunityAssetView = {
  asset: Address;
  balance: bigint;
  price: bigint;
  priceDecimals: number;
  assetDecimals: number;
  updatedAt: bigint;
  valueUsd: bigint;
  priced: boolean;
  stale: boolean;
};

export type CombinedBacking = {
  token: Address;
  treasury: Address;
  vault: Address;
  creatorFundedUsd: bigint;
  creatorFundedOk: boolean;
  creatorFundedAnyStale: boolean;
  communityWithdrawableUsd: bigint;
  communityAnyStale: boolean;
  communityAnyUnpriced: boolean;
  combinedTotalUsd: bigint;
  communityAssets: CommunityAssetView[];
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Open Treasury state for one token's page. Resolves the vault (if one has
 * been created — `getOrCreateVault` only ever runs from an explicit deposit
 * action, never a read), the combined backing split (rule 18's three
 * figures), the reward-stream state, and — if a wallet is connected — the
 * connected account's own per-asset principal/claimable position.
 *
 * Renders nothing when `isOpenTreasuryEnabled` is false (feature flag, off by
 * default) — callers should gate the whole section on `enabled` below.
 */
export function useOpenTreasury(token?: Address, listedAssets: AllowedAsset[] = []) {
  const { address: account } = useAccount();
  const enabled = isOpenTreasuryEnabled && Boolean(token);

  const vaultRes = useReadContract({
    address: OPEN_TREASURY_FACTORY_ADDRESS,
    abi: openTreasuryVaultFactoryAbi,
    functionName: "vaultOf",
    args: token ? [token] : undefined,
    chainId: CHAIN_ID,
    query: liveQuery(enabled),
  });
  const vault = vaultRes.data && vaultRes.data !== ZERO ? (vaultRes.data as Address) : undefined;

  const predictedRes = useReadContract({
    address: OPEN_TREASURY_FACTORY_ADDRESS,
    abi: openTreasuryVaultFactoryAbi,
    functionName: "vaultFor",
    args: token ? [token] : undefined,
    chainId: CHAIN_ID,
    query: liveQuery(enabled && !vault),
  });
  const predictedVault = predictedRes.data as Address | undefined;

  const backingRes = useReadContract({
    address: OPEN_TREASURY_LENS_ADDRESS,
    abi: openTreasuryLensAbi,
    functionName: "combinedBackingOf",
    args: token && OPEN_TREASURY_FACTORY_ADDRESS ? [token, OPEN_TREASURY_FACTORY_ADDRESS] : undefined,
    chainId: CHAIN_ID,
    query: liveQuery(enabled && Boolean(OPEN_TREASURY_FACTORY_ADDRESS)),
  });
  const backing = backingRes.data as unknown as CombinedBacking | undefined;

  const vaultStateRes = useReadContracts({
    allowFailure: true,
    contracts: vault
      ? ([
          { address: vault, abi: openTreasuryVaultAbi, functionName: "minHoldTime", chainId: CHAIN_ID },
          { address: vault, abi: openTreasuryVaultAbi, functionName: "rewardsDuration", chainId: CHAIN_ID },
          { address: vault, abi: openTreasuryVaultAbi, functionName: "rewardAsset", chainId: CHAIN_ID },
          { address: vault, abi: openTreasuryVaultAbi, functionName: "periodFinish", chainId: CHAIN_ID },
          { address: vault, abi: openTreasuryVaultAbi, functionName: "rewardRate", chainId: CHAIN_ID },
          { address: vault, abi: openTreasuryVaultAbi, functionName: "totalRewardDeposited", chainId: CHAIN_ID },
          { address: vault, abi: openTreasuryVaultAbi, functionName: "totalWeight", chainId: CHAIN_ID },
        ] as const)
      : [],
    query: liveQuery(enabled && Boolean(vault)),
  });
  const pick = (i: number) => (vaultStateRes.data?.[i]?.status === "success" ? vaultStateRes.data[i].result : undefined);
  const minHoldTime = pick(0) as bigint | undefined;
  const rewardsDuration = pick(1) as bigint | undefined;
  const rewardAsset = pick(2) as Address | undefined;
  const periodFinish = pick(3) as bigint | undefined;
  const rewardRate = pick(4) as bigint | undefined;
  const totalRewardDeposited = pick(5) as bigint | undefined;
  const totalWeight = pick(6) as bigint | undefined;

  // Per-connected-account position across every listed asset (not just ones
  // already deposited — lets the deposit form show "0" cleanly for new assets).
  const assetAddrs = listedAssets.map((a) => a.address);
  const positionRes = useReadContracts({
    allowFailure: true,
    contracts:
      vault && account
        ? assetAddrs.flatMap((a) => [
            { address: vault, abi: openTreasuryVaultAbi, functionName: "principal", args: [account, a], chainId: CHAIN_ID } as const,
            { address: vault, abi: openTreasuryVaultAbi, functionName: "pendingWithdrawAt", args: [account, a], chainId: CHAIN_ID } as const,
          ])
        : [],
    query: liveQuery(enabled && Boolean(vault && account) && assetAddrs.length > 0),
  });
  const positions = assetAddrs.map((asset, i) => {
    const p = positionRes.data?.[i * 2];
    const u = positionRes.data?.[i * 2 + 1];
    return {
      asset,
      principal: p?.status === "success" ? (p.result as bigint) : 0n,
      unlockAt: u?.status === "success" ? (u.result as bigint) : 0n,
    };
  });

  const earnedRes = useReadContract({
    address: vault,
    abi: openTreasuryVaultAbi,
    functionName: "earned",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: liveQuery(enabled && Boolean(vault && account)),
  });
  const earned = (earnedRes.data as bigint | undefined) ?? 0n;

  return {
    enabled,
    vault,
    predictedVault,
    backing,
    minHoldTime,
    rewardsDuration,
    rewardAsset,
    periodFinish,
    rewardRate,
    totalRewardDeposited,
    totalWeight,
    positions,
    earned,
    isLoading: vaultRes.isLoading || backingRes.isLoading,
    refetchAll: () => {
      void vaultRes.refetch();
      void backingRes.refetch();
      void vaultStateRes.refetch();
      void positionRes.refetch();
      void earnedRes.refetch();
    },
  };
}
