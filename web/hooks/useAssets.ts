"use client";

import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { assetRegistryAbi, erc20Abi, aggregatorV3Abi } from "@/lib/abis";
import { ASSET_REGISTRY_ADDRESS, isRegistryConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;

export type AllowedAsset = {
  address: Address;
  symbol?: string;
  decimals?: number;
  feed: Address;
  marketHours: number; // 0 Unknown, 1 UsEquities24_5, 2 Crypto24_7
  minDeposit: bigint;
  staleAfter?: bigint; // per-asset outer freshness bound (seconds)
  price?: bigint; // raw feed answer
  priceDecimals?: number;
  updatedAt?: bigint;
};

/** Reads the AssetRegistry allowlist and, for each asset, its ERC-20 metadata and
 *  live Chainlink feed round — everything the create flow needs to price a deposit
 *  and gate on market hours. Batched via multicall. */
export function useAssets() {
  const listRes = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: assetRegistryAbi,
    functionName: "allowedAssets",
    chainId: CHAIN_ID,
    query: { enabled: isRegistryConfigured },
  });

  const list = (listRes.data as Address[] | undefined) ?? [];

  const detailRes = useReadContracts({
    allowFailure: true,
    contracts: list.flatMap((a) => [
      { address: ASSET_REGISTRY_ADDRESS!, abi: assetRegistryAbi, functionName: "assetConfig", args: [a], chainId: CHAIN_ID } as const,
      { address: a, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID } as const,
      { address: a, abi: erc20Abi, functionName: "decimals", chainId: CHAIN_ID } as const,
    ]),
    query: { enabled: isRegistryConfigured && list.length > 0 },
  });

  // Feed addresses come from assetConfig; read each feed's round + decimals.
  const configs = list.map((_, i) => {
    const r = detailRes.data?.[i * 3];
    return r?.status === "success"
      ? (r.result as unknown as [boolean, Address, bigint, bigint, number])
      : undefined;
  });

  const feedRes = useReadContracts({
    allowFailure: true,
    contracts: configs.flatMap((c) =>
      c
        ? [
            { address: c[1], abi: aggregatorV3Abi, functionName: "latestRoundData", chainId: CHAIN_ID } as const,
            { address: c[1], abi: aggregatorV3Abi, functionName: "decimals", chainId: CHAIN_ID } as const,
          ]
        : [],
    ),
    query: { enabled: configs.some(Boolean) },
  });

  const assets: AllowedAsset[] = [];
  let feedCursor = 0;
  list.forEach((address, i) => {
    const cfg = configs[i];
    const sym = detailRes.data?.[i * 3 + 1];
    const dec = detailRes.data?.[i * 3 + 2];
    if (!cfg) {
      assets.push({ address, feed: "0x0000000000000000000000000000000000000000", marketHours: 0, minDeposit: 0n });
      return;
    }
    const round = feedRes.data?.[feedCursor];
    const fdec = feedRes.data?.[feedCursor + 1];
    feedCursor += 2;
    const rd =
      round?.status === "success"
        ? (round.result as unknown as [bigint, bigint, bigint, bigint, bigint])
        : undefined;
    assets.push({
      address,
      symbol: sym?.status === "success" ? (sym.result as string) : undefined,
      decimals: dec?.status === "success" ? (dec.result as number) : undefined,
      feed: cfg[1],
      marketHours: Number(cfg[4]),
      minDeposit: cfg[3] as bigint,
      staleAfter: cfg[2] as bigint,
      price: rd ? (rd[1] as bigint) : undefined,
      priceDecimals: fdec?.status === "success" ? (fdec.result as number) : undefined,
      updatedAt: rd ? (rd[3] as bigint) : undefined,
    });
  });

  return {
    assets,
    isConfigured: isRegistryConfigured,
    isLoading: listRes.isLoading || detailRes.isLoading || feedRes.isLoading,
    // Distinguish "the allowlist read failed" (RPC down) from "the allowlist is
    // genuinely empty" — otherwise a failed read masquerades as "no assets yet".
    isError: listRes.isError,
    hasAssets: list.length > 0,
  };
}
