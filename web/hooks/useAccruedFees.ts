"use client";

import { useCallback, useState } from "react";
import { useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { ballastHookAbi, aggregatorV3Abi } from "@/lib/abis";
import { HOOK_ADDRESSES, ETH_USD_FEED_ADDRESS, WETH_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import { useInvalidateChainReads } from "@/hooks/useInvalidateChainReads";
import { useAssets } from "@/hooks/useAssets";

export type OtherOwed = {
  currency: Address;
  symbol?: string;
  amount: bigint;
  decimals: number;
};

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
  const invalidateChainReads = useInvalidateChainReads();
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

  // Non-WETH quote-asset fees (e.g. NVDA, SPY, SGOV — any registry-allowed
  // asset a pool might be quoted in). Probed against EVERY hook × EVERY
  // registry asset: pre-gen-4 hooks lack owedIn entirely (the call simply
  // fails, allowFailure), and most (hook, currency) pairs read 0 — both
  // harmless, since this is the only way to discover which currencies a
  // creator/vault/referrer actually has a balance in without an indexer.
  const { assets } = useAssets();
  const otherCandidates = assets.filter((a) => !WETH_ADDRESS || a.address.toLowerCase() !== WETH_ADDRESS.toLowerCase());
  const otherOwedRes = useReadContracts({
    allowFailure: true,
    contracts: HOOK_ADDRESSES.flatMap((hook) =>
      otherCandidates.map(
        (a) =>
          ({
            address: hook,
            abi: ballastHookAbi,
            functionName: "owedIn",
            args: account ? [account, a.address] : undefined,
            chainId: CHAIN_ID,
          }) as const,
      ),
    ),
    query: { enabled: Boolean(account) && HOOK_ADDRESSES.length > 0 && otherCandidates.length > 0, refetchInterval: 30_000 },
  });
  // (hook, currency) pairs with a real balance — this is exactly what claim()
  // below iterates to call claimIn(currency) on the right hook.
  const otherPerHookCurrency: { hook: Address; currency: Address; amount: bigint }[] = [];
  HOOK_ADDRESSES.forEach((hook, hi) => {
    otherCandidates.forEach((a, ai) => {
      const r = otherOwedRes.data?.[hi * otherCandidates.length + ai];
      if (r?.status === "success" && (r.result as bigint) > 0n) {
        otherPerHookCurrency.push({ hook, currency: a.address, amount: r.result as bigint });
      }
    });
  });
  // Summed per currency (across hooks) for display.
  const otherOwed: OtherOwed[] = otherCandidates
    .map((a) => {
      const amount = otherPerHookCurrency.filter((x) => x.currency.toLowerCase() === a.address.toLowerCase()).reduce((s, x) => s + x.amount, 0n);
      return { currency: a.address, symbol: a.symbol, amount, decimals: a.decimals ?? 18 };
    })
    .filter((o) => o.amount > 0n);

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

  // Claim EVERYTHING owed: WETH via claim() (one tx per hook with a WETH
  // balance) THEN every non-WETH currency via claimIn(currency) (one tx per
  // (hook, currency) pair with a balance — typically zero or one today, since
  // only gen-4's NVDA-quoted pool can produce these). A reverted/lost claim
  // stops the loop and surfaces the hash; already-swept (hook, currency)
  // pairs stay swept, so a retry only re-hits what's still owing.
  const claim = useCallback(async () => {
    if (!publicClient || !account) return;
    if (hooksWithBalance.length === 0 && otherPerHookCurrency.length === 0) return;
    setError(undefined);
    setTxHash(undefined);
    setPhase("claiming");
    try {
      for (const { hook } of hooksWithBalance) {
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
      for (const { hook, currency } of otherPerHookCurrency) {
        const hash = await writeContractAsync({
          address: hook,
          abi: ballastHookAbi,
          functionName: "claimIn",
          args: [currency],
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
      void otherOwedRes.refetch();
      invalidateChainReads(); // fees claimed → wallet balance + owed refresh now
    } catch (e) {
      setError(decodeTxError(e));
      setPhase("error");
    }
  }, [account, publicClient, writeContractAsync, hooksWithBalance, otherPerHookCurrency, owedRes, otherOwedRes, invalidateChainReads]);

  const totalClaimTxCount = hooksWithBalance.length + otherPerHookCurrency.length;

  return {
    accruedWeth,
    accruedUsd1e18,
    otherOwed, // non-WETH currencies (e.g. NVDA) with a real balance — empty array if none
    phase,
    txHash,
    error,
    isConfigured: HOOK_ADDRESSES.length > 0,
    isLoading: owedRes.isLoading || otherOwedRes.isLoading,
    // >1 total claim tx means the claim will prompt more than once (see FeePanel note)
    // — either an earlier hook version still owing WETH, or a non-WETH currency.
    claimSpansHooks: totalClaimTxCount > 1,
    claim,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}
