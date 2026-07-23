"use client";

import { useMemo } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { erc20Abi, stateViewAbi, aggregatorV3Abi } from "@/lib/abis";
import { STATE_VIEW_ADDRESS, ETH_USD_FEED_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { poolKeyForToken, poolId, priceFromSqrtX96 } from "@/lib/pool";
import { useProjects, type Project } from "./useProjects";

const CHAIN_ID = activeChain.id;

export type Holding = {
  project: Project;
  balance: bigint;
  backingValueUsd: bigint; // balance × backingPerToken (on-chain verifiable)
  marketValueUsd?: bigint; // balance × market price, when a pool exists
  displayValueUsd: bigint; // market if available, else backing
};

/** The connected wallet's BALLAST holdings across every launch, valued at backing
 *  (verifiable) and — where a pool exists — at market. My-launches is the subset
 *  where the wallet is the creator. */
export function usePortfolio() {
  const { address: account, isConnected } = useAccount();
  const { projects, isLoading: projLoading, isConfigured } = useProjects();

  // balanceOf(token, account) for every launched token.
  const balRes = useReadContracts({
    allowFailure: true,
    contracts: account
      ? projects.map((p) => ({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: CHAIN_ID }) as const)
      : [],
    query: { enabled: Boolean(account) && projects.length > 0 },
  });

  // Market price per token (getSlot0) — homogeneous stateView reads.
  const priceRes = useReadContracts({
    allowFailure: true,
    contracts:
      STATE_VIEW_ADDRESS && projects.length > 0
        ? projects.map((p) => {
            const key = poolKeyForToken(p.token);
            return { address: STATE_VIEW_ADDRESS!, abi: stateViewAbi, functionName: "getSlot0", args: [key ? poolId(key) : ("0x0" as `0x${string}`)], chainId: CHAIN_ID } as const;
          })
        : [],
    query: { enabled: Boolean(STATE_VIEW_ADDRESS) && projects.length > 0 },
  });

  // ETH/USD once — separate so the ABIs stay homogeneous per call.
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

  const ethUsd1e18 = useMemo(() => {
    const round = ethRes.data?.[0];
    const dec = ethRes.data?.[1];
    if (round?.status === "success" && dec?.status === "success") {
      const answer = (round.result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
      if (answer > 0n) return (answer * 10n ** 18n) / 10n ** BigInt(dec.result as number);
    }
    return undefined;
  }, [ethRes.data]);

  const holdings: Holding[] = [];
  projects.forEach((p, i) => {
    const b = balRes.data?.[i];
    const balance = b?.status === "success" ? (b.result as bigint) : 0n;
    if (balance === 0n) return;

    const bpt = p.backing?.backingPerToken ?? 0n;
    const backingValueUsd = (balance * bpt) / 10n ** 18n;

    let marketValueUsd: bigint | undefined;
    const slot0 = priceRes.data?.[i];
    if (slot0?.status === "success" && ethUsd1e18 !== undefined) {
      const sqrtP = (slot0.result as unknown as [bigint, number, number, number])[0];
      if (sqrtP > 0n) {
        const priceWeth = priceFromSqrtX96(sqrtP);
        const priceUsd = (priceWeth * ethUsd1e18) / 10n ** 18n;
        marketValueUsd = (balance * priceUsd) / 10n ** 18n;
      }
    }
    holdings.push({
      project: p,
      balance,
      backingValueUsd,
      marketValueUsd,
      displayValueUsd: marketValueUsd ?? backingValueUsd,
    });
  });

  const totalValue = holdings.reduce((s, h) => s + h.displayValueUsd, 0n);
  const backedValue = holdings.filter((h) => h.project.ballasted).reduce((s, h) => s + h.displayValueUsd, 0n);
  const unbackedValue = totalValue - backedValue;

  const myLaunches = account
    ? projects.filter((p) => p.creator.toLowerCase() === account.toLowerCase())
    : [];

  return {
    isConnected,
    isConfigured,
    isLoading: projLoading || balRes.isLoading,
    holdings,
    myLaunches,
    totalValue,
    backedValue,
    unbackedValue,
    hasMarketData: holdings.some((h) => h.marketValueUsd !== undefined),
  };
}
