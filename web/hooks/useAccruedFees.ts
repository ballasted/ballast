"use client";

import { useCallback, useState } from "react";
import { useReadContract, useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { ballastHookAbi, aggregatorV3Abi } from "@/lib/abis";
import { HOOK_ADDRESS, ETH_USD_FEED_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";

const CHAIN_ID = activeChain.id;

export type ClaimPhase = "idle" | "claiming" | "success" | "error";

/**
 * The WETH swap fees accrued to `account` in BallastHook, and the claim action.
 *
 * `owed` is per-RECIPIENT, not per-token: a creator's balance is the sum across all
 * their launches, and `claim()` sweeps the whole thing to the caller. The same path
 * serves the platform vault and any referrer — claim() has no access control beyond
 * "you can only take your own balance". Fees are paid out as WETH (an ERC-20 on this
 * chain), not unwrapped to native ETH.
 */
export function useAccruedFees(account?: Address) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  const owedRes = useReadContract({
    address: HOOK_ADDRESS,
    abi: ballastHookAbi,
    functionName: "owed",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(HOOK_ADDRESS && account), refetchInterval: 30_000 },
  });
  const accruedWeth = owedRes.data as bigint | undefined;

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

  const claim = useCallback(async () => {
    if (!HOOK_ADDRESS || !publicClient || !account) return;
    setError(undefined);
    setTxHash(undefined);
    setPhase("claiming");
    try {
      const hash = await writeContractAsync({
        address: HOOK_ADDRESS,
        abi: ballastHookAbi,
        functionName: "claim",
        chainId: CHAIN_ID,
      });
      setTxHash(hash);
      const outcome = await pollReceipt(publicClient, hash);
      if (outcome.status === "lost") {
        throw new Error(`We lost track of the claim — check Blockscout before retrying: ${hash}`);
      }
      if (outcome.status === "reverted") {
        throw new Error(`Claim reverted — check Blockscout: ${hash}`);
      }
      setPhase("success");
      void owedRes.refetch();
    } catch (e) {
      setError(decodeTxError(e));
      setPhase("error");
    }
  }, [account, publicClient, writeContractAsync, owedRes]);

  return {
    accruedWeth,
    accruedUsd1e18,
    phase,
    txHash,
    error,
    isConfigured: Boolean(HOOK_ADDRESS),
    isLoading: owedRes.isLoading,
    claim,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}
