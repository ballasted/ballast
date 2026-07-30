"use client";

import { useAccount, useReadContracts } from "wagmi";
import { erc20Abi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
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

  // Market price per token comes straight from useProjects, which reads it on-chain
  // from the v4 StateView and — crucially — is HOOK-AWARE (it probes every deployed
  // hook and uses whichever holds the token's live pool). Reusing it keeps the
  // portfolio consistent with Discover/token pages AND correct for prior-hook tokens
  // after a hook redeploy, with no second round of pool reads here.
  const holdings: Holding[] = [];
  projects.forEach((p, i) => {
    const b = balRes.data?.[i];
    const balance = b?.status === "success" ? (b.result as bigint) : 0n;
    if (balance === 0n) return;

    const bpt = p.backing?.backingPerToken ?? 0n;
    const backingValueUsd = (balance * bpt) / 10n ** 18n;

    const marketValueUsd =
      p.marketPriceUsd !== undefined ? (balance * p.marketPriceUsd) / 10n ** 18n : undefined;
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
