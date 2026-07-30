"use client";

import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import {
  backingLensAbi,
  projectTreasuryAbi,
  erc20Abi,
  ballastTokenAbi,
  ballastFactoryAbi,
  stateViewAbi,
  aggregatorV3Abi,
} from "@/lib/abis";
import {
  LENS_ADDRESS,
  FACTORY_ADDRESS,
  STATE_VIEW_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  isLensConfigured,
  isSwapConfigured,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { candidatePoolKeys, priceFromSqrtX96 } from "@/lib/pool";
import type { ProjectBacking } from "./useProjects";

const CHAIN_ID = activeChain.id;

export type PendingWithdrawal = {
  id: bigint;
  asset: Address;
  amount: bigint;
  unlockAt: bigint;
};

/**
 * Token-detail data, keyed by the TOKEN address (the shareable unit). Resolves the
 * treasury on-chain via token.treasury(), reads backing through BackingLens, the
 * pending withdrawal, and — if a pool exists — the live market price from the v4
 * StateView, converted to USD via the ETH/USD feed. Reads are grouped by contract
 * (homogeneous ABIs) and batched through the multicall transport.
 */
export function useBacking(token?: Address) {
  // token -> treasury (immutable pointer).
  const treasuryRes = useReadContract({
    address: token,
    abi: ballastTokenAbi,
    functionName: "treasury",
    chainId: CHAIN_ID,
    query: { enabled: Boolean(token) },
  });
  const treasury = treasuryRes.data as Address | undefined;

  const metaRes = useReadContracts({
    allowFailure: true,
    contracts: token
      ? [
          { address: token, abi: erc20Abi, functionName: "name", chainId: CHAIN_ID },
          { address: token, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "metadataURI", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "launchMetadataURI", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "metadataChanged", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "creator", chainId: CHAIN_ID },
          { address: token, abi: erc20Abi, functionName: "totalSupply", chainId: CHAIN_ID },
        ]
      : [],
    query: { enabled: Boolean(token) },
  });
  const pick = (i: number) => (metaRes.data?.[i]?.status === "success" ? metaRes.data[i].result : undefined);
  const name = pick(0) as string | undefined;
  const symbol = pick(1) as string | undefined;
  // On-chain pointer to the pinned project metadata JSON (the source of truth).
  const metadataURI = pick(2) as string | undefined;
  const launchMetadataURI = pick(3) as string | undefined;
  const metadataChanged = Boolean(pick(4));
  const creator = pick(5) as Address | undefined;
  const totalSupply = pick(6) as bigint | undefined;

  const graduatedRes = useReadContract({
    address: FACTORY_ADDRESS,
    abi: ballastFactoryAbi,
    functionName: "graduated",
    args: token ? [token] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(token && FACTORY_ADDRESS) },
  });
  const graduated = Boolean(graduatedRes.data);

  const backingRes = useReadContract({
    address: LENS_ADDRESS,
    abi: backingLensAbi,
    functionName: "backingOf",
    args: treasury ? [treasury] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: isLensConfigured && Boolean(treasury) },
  });
  const backing = backingRes.data as unknown as ProjectBacking | undefined;

  const treasuryStateRes = useReadContracts({
    allowFailure: true,
    contracts: treasury
      ? [
          { address: treasury, abi: projectTreasuryAbi, functionName: "pendingWithdrawal", chainId: CHAIN_ID },
          { address: treasury, abi: projectTreasuryAbi, functionName: "noticePeriod", chainId: CHAIN_ID },
        ]
      : [],
    query: { enabled: Boolean(treasury) },
  });
  let pending: PendingWithdrawal | undefined;
  const pw = treasuryStateRes.data?.[0];
  if (pw?.status === "success") {
    const [id, asset, amount, unlockAt] = pw.result as unknown as [bigint, Address, bigint, bigint];
    if (id > 0n) pending = { id, asset, amount, unlockAt };
  }
  const noticePeriod =
    treasuryStateRes.data?.[1]?.status === "success" ? (treasuryStateRes.data[1].result as bigint) : undefined;

  // Market price via StateView(getSlot0/getLiquidity) + ETH/USD feed. Hook-aware: a
  // token's pool lives under exactly one of the deployed hooks (its own, fixed at
  // graduation), so probe every candidate and use the one with live liquidity. This
  // is why a prior-hook token ($BALLAST/CHRS) keeps an on-chain price after a hook
  // redeploy instead of silently reading the wrong (empty) poolId.
  const candidates = token ? candidatePoolKeys(token) : [];
  const poolRes = useReadContracts({
    allowFailure: true,
    contracts:
      STATE_VIEW_ADDRESS && candidates.length > 0
        ? candidates.flatMap((c) => [
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getSlot0", args: [c.id], chainId: CHAIN_ID } as const,
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getLiquidity", args: [c.id], chainId: CHAIN_ID } as const,
          ])
        : [],
    query: { enabled: isSwapConfigured && candidates.length > 0 },
  });
  const ethRes = useReadContracts({
    allowFailure: true,
    contracts: ETH_USD_FEED_ADDRESS
      ? [
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "latestRoundData", chainId: CHAIN_ID },
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "decimals", chainId: CHAIN_ID },
        ]
      : [],
    query: { enabled: Boolean(ETH_USD_FEED_ADDRESS) },
  });

  // Pick the first candidate hook whose pool has live liquidity (newest-first).
  let hasPool = false;
  let marketPriceWeth: bigint | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const slot0 = poolRes.data?.[i * 2];
    const liq = poolRes.data?.[i * 2 + 1];
    if (liq?.status === "success" && (liq.result as bigint) > 0n) {
      hasPool = true;
      if (slot0?.status === "success") {
        const [sqrtPriceX96] = slot0.result as unknown as [bigint, number, number, number];
        if (sqrtPriceX96 > 0n) marketPriceWeth = priceFromSqrtX96(sqrtPriceX96);
      }
      break;
    }
  }

  let ethUsd1e18: bigint | undefined;
  if (ethRes.data?.[0]?.status === "success" && ethRes.data?.[1]?.status === "success") {
    const answer = (ethRes.data[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer > 0n) ethUsd1e18 = (answer * 10n ** 18n) / 10n ** BigInt(ethRes.data[1].result as number);
  }
  const marketPriceUsd =
    marketPriceWeth !== undefined && ethUsd1e18 !== undefined
      ? (marketPriceWeth * ethUsd1e18) / 10n ** 18n
      : undefined;

  return {
    treasury,
    token,
    backing,
    name,
    symbol,
    metadataURI,
    launchMetadataURI,
    metadataChanged,
    creator,
    totalSupply,
    pending,
    noticePeriod,
    graduated,
    hasPool,
    marketPriceWeth,
    marketPriceUsd,
    isConfigured: isLensConfigured,
    isLoading: treasuryRes.isLoading || backingRes.isLoading,
    found: Boolean(treasury),
  };
}
