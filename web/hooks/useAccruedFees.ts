"use client";

import { useCallback, useState } from "react";
import { useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { ballastHookAbi, aggregatorV3Abi } from "@/lib/abis";
import { HOOK_ADDRESSES, ETH_USD_FEED_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";

const CHAIN_ID = activeChain.id;

export type ClaimPhase = "idle" | "claiming" | "success" | "error";

/**
 * The WETH swap fees accrued to `account` across EVERY BallastHook we've deployed,
 * and the claim action.
 *
 * `owed` is per-RECIPIENT, not per-token, and it lives on the hook contract that took
 * the fee. Because the hook is baked into each pool's immutable PoolKey, a hook
 * redeploy leaves prior pools' fees on the OLD hook forever — so a single-hook read
 * would hide (and a single-hook claim would strand) everything earned before the
 * redeploy. We therefore read `owed(account)` on all HOOK_ADDRESSES, SUM them for the
 * displayed balance, and `claim()` from each hook that has a balance (one tx per hook
 * with funds). Same path serves creators, the platform vault, and referrers. Fees pay
 * out as WETH (an ERC-20 here), not unwrapped to native ETH.
 */
export function useAccruedFees(account?: Address) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  const owedRes = useReadContracts({
    allowFailure: true,
    contracts: HOOK_ADDRESSES.map((hook) => ({
      address: hook,
      abi: ballastHookAbi,
      functionName: "owed",
      args: account ? [account] : undefined,
      chainId: CHAIN_ID,
    })),
    query: { enabled: Boolean(account) && HOOK_ADDRESSES.length > 0, refetchInterval: 30_000 },
  });
  // Per-hook owed, aligned to HOOK_ADDRESSES. Undefined until the first read resolves
  // (so the UI shows "…" not a premature 0).
  const perHook = HOOK_ADDRESSES.map((hook, i) => ({
    hook,
    owed: owedRes.data?.[i]?.status === "success" ? (owedRes.data[i].result as bigint) : 0n,
  }));
  const accruedWeth = owedRes.data !== undefined ? perHook.reduce((s, x) => s + x.owed, 0n) : undefined;
  const hooksWithBalance = perHook.filter((x) => x.owed > 0n);

  // WETH ≈ ETH 1:1, so the ETH/USD feed gives the USD equivalent. Decimals read
  // live from the feed, never assumed (CLAUDE.md rule 9).
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
  let ethUsd1e18: bigint | undefined;
  if (ethRes.data?.[0]?.status === "success" && ethRes.data?.[1]?.status === "success") {
    const answer = (ethRes.data[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer > 0n) ethUsd1e18 = (answer * 10n ** 18n) / 10n ** BigInt(ethRes.data[1].result as number);
  }
  const accruedUsd1e18 =
    accruedWeth !== undefined && ethUsd1e18 !== undefined ? (accruedWeth * ethUsd1e18) / 10n ** 18n : undefined;

  // Claim from EACH hook that owes this account — one tx per hook with a balance
  // (typically one; two only right after a hook redeploy while old fees remain). A
  // reverted/lost claim stops the loop and surfaces the hash; already-swept hooks
  // stay swept, so a retry only re-hits the ones still owing.
  const claim = useCallback(async () => {
    if (!publicClient || !account) return;
    const targets = hooksWithBalance;
    if (targets.length === 0) return;
    setError(undefined);
    setTxHash(undefined);
    setPhase("claiming");
    try {
      for (const { hook } of targets) {
        const hash = await writeContractAsync({
          address: hook,
          abi: ballastHookAbi,
          functionName: "claim",
          chainId: CHAIN_ID,
        });
        setTxHash(hash);
        const outcome = await pollReceipt(publicClient, hash);
        if (outcome.status === "lost") {
          throw new Error(`We lost track of a claim — check Blockscout before retrying: ${hash}`);
        }
        if (outcome.status === "reverted") {
          throw new Error(`A claim reverted — check Blockscout: ${hash}`);
        }
      }
      setPhase("success");
      void owedRes.refetch();
    } catch (e) {
      setError(decodeTxError(e));
      setPhase("error");
    }
  }, [account, publicClient, writeContractAsync, hooksWithBalance, owedRes]);

  return {
    accruedWeth,
    accruedUsd1e18,
    phase,
    txHash,
    error,
    isConfigured: HOOK_ADDRESSES.length > 0,
    isLoading: owedRes.isLoading,
    // >1 hook owing means the claim will prompt more than once (see FeePanel note).
    claimSpansHooks: hooksWithBalance.length > 1,
    claim,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}
