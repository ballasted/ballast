"use client";

import { useCallback, useEffect, useState } from "react";
import { useReadContract, useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { erc20Abi } from "@/lib/abis";
import { V1_CLAIM_ADDRESS, V1_TOKEN_ADDRESS, isV1ClaimConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";

const CHAIN_ID = activeChain.id;

export const ballastV1ClaimAbi = [
  { type: "function", name: "merkleRoot", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "deadline", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "burnedOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountV1", type: "uint256" },
      { name: "snapshotBalance", type: "uint256" },
      { name: "ethAmount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [{ name: "ethPaid", type: "uint256" }],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "v1Burned", type: "uint256", indexed: false },
      { name: "ethPaid", type: "uint256", indexed: false },
      { name: "cumulativeBurned", type: "uint256", indexed: false },
      { name: "snapshotBalance", type: "uint256", indexed: false },
    ],
  },
] as const;

type ClaimEntry = {
  balanceWei: string;
  ethAmountWei: string;
  usdValue: string;
  leaf: `0x${string}`;
  proof: `0x${string}`[];
};
type ClaimData = { root: `0x${string}`; holders: number; claims: Record<string, ClaimEntry> };

let cachedClaimData: ClaimData | null = null;
async function loadClaimData(): Promise<ClaimData> {
  if (cachedClaimData) return cachedClaimData;
  const res = await fetch("/data/v1-claim-merkle.json");
  if (!res.ok) throw new Error("Could not load the claim list");
  cachedClaimData = (await res.json()) as ClaimData;
  return cachedClaimData;
}

export type ClaimPhase = "idle" | "approving" | "claiming" | "success" | "error";

export type MigrationStats = {
  isLoading: boolean;
  error: boolean;
  claimCount: number;
  uniqueClaimers: number;
  totalEthPaid: bigint;
  totalV1Burned: bigint;
};

/** Global migration progress, swept from `Claimed` events — the same
 *  getContractEvents pattern useBuyback's history uses. Independent of any
 *  connected wallet. */
export function useMigrationStats(): MigrationStats {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [stats, setStats] = useState<MigrationStats>({
    isLoading: true,
    error: false,
    claimCount: 0,
    uniqueClaimers: 0,
    totalEthPaid: 0n,
    totalV1Burned: 0n,
  });

  useEffect(() => {
    if (!publicClient || !V1_CLAIM_ADDRESS) {
      setStats((s) => ({ ...s, isLoading: false }));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const logs = await publicClient.getContractEvents({
          address: V1_CLAIM_ADDRESS,
          abi: ballastV1ClaimAbi,
          eventName: "Claimed",
          fromBlock: "earliest",
          toBlock: "latest",
        });
        if (cancelled) return;
        const claimers = new Set<string>();
        let ethPaid = 0n;
        let v1Burned = 0n;
        for (const l of logs) {
          const a = l.args as { account?: Address; v1Burned?: bigint; ethPaid?: bigint };
          if (a.account) claimers.add(a.account.toLowerCase());
          ethPaid += a.ethPaid ?? 0n;
          v1Burned += a.v1Burned ?? 0n;
        }
        setStats({
          isLoading: false,
          error: false,
          claimCount: logs.length,
          uniqueClaimers: claimers.size,
          totalEthPaid: ethPaid,
          totalV1Burned: v1Burned,
        });
      } catch {
        if (!cancelled) setStats((s) => ({ ...s, isLoading: false, error: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  return stats;
}

export function useV1Claim(account?: Address) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [entry, setEntry] = useState<ClaimEntry | undefined>(undefined);
  const [holders, setHolders] = useState<number | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    loadClaimData()
      .then((d) => {
        if (cancelled) return;
        setHolders(d.holders);
        setEntry(account ? d.claims[account.toLowerCase()] : undefined);
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, [account]);

  const snapshotBalance = entry ? BigInt(entry.balanceWei) : undefined;
  const ethAmount = entry ? BigInt(entry.ethAmountWei) : undefined;

  const stateRes = useReadContracts({
    allowFailure: true,
    contracts:
      V1_CLAIM_ADDRESS && account
        ? ([
            { address: V1_CLAIM_ADDRESS, abi: ballastV1ClaimAbi, functionName: "burnedOf", args: [account], chainId: CHAIN_ID },
            { address: V1_CLAIM_ADDRESS, abi: ballastV1ClaimAbi, functionName: "deadline", chainId: CHAIN_ID },
            { address: V1_TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: CHAIN_ID },
            {
              address: V1_TOKEN_ADDRESS,
              abi: erc20Abi,
              functionName: "allowance",
              args: [account, V1_CLAIM_ADDRESS],
              chainId: CHAIN_ID,
            },
          ] as const)
        : [],
    query: liveQuery(isV1ClaimConfigured && Boolean(account)),
  });

  const pick = (i: number) => (stateRes.data?.[i]?.status === "success" ? stateRes.data[i].result : undefined);
  const burned = pick(0) as bigint | undefined;
  const deadline = pick(1) as bigint | undefined;
  const v1Balance = pick(2) as bigint | undefined;
  const allowance = pick(3) as bigint | undefined;

  const remaining = snapshotBalance !== undefined && burned !== undefined ? snapshotBalance - burned : undefined;
  const claimedEth =
    ethAmount !== undefined && snapshotBalance !== undefined && snapshotBalance > 0n && burned !== undefined
      ? (ethAmount * burned) / snapshotBalance
      : undefined;
  const fullyClaimed = remaining !== undefined && remaining <= 0n;
  const deadlinePassed = deadline !== undefined && deadline > 0n && BigInt(Math.floor(Date.now() / 1000)) >= deadline;

  const claim = useCallback(
    async (amountV1: bigint) => {
      if (!publicClient || !account || !entry || !V1_CLAIM_ADDRESS) return;
      setError(undefined);
      setTxHash(undefined);
      try {
        if (allowance === undefined || allowance < amountV1) {
          setPhase("approving");
          const approveHash = await writeContractAsync({
            address: V1_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [V1_CLAIM_ADDRESS, amountV1],
            chainId: CHAIN_ID,
          });
          const outcome = await pollReceipt(publicClient, approveHash);
          if (outcome.status !== "success") throw new Error("Approval did not confirm");
        }
        setPhase("claiming");
        const hash = await writeContractAsync({
          address: V1_CLAIM_ADDRESS,
          abi: ballastV1ClaimAbi,
          functionName: "claim",
          args: [amountV1, BigInt(entry.balanceWei), BigInt(entry.ethAmountWei), entry.proof],
          chainId: CHAIN_ID,
        });
        setTxHash(hash);
        const outcome = await pollReceipt(publicClient, hash);
        if (outcome.status === "lost") throw new Error(`We lost track of the claim — check Blockscout: ${hash}`);
        if (outcome.status === "reverted") throw new Error(`The claim reverted — check Blockscout: ${hash}`);
        setPhase("success");
        void stateRes.refetch();
      } catch (e) {
        setError(decodeTxError(e));
        setPhase("error");
      }
    },
    [publicClient, account, entry, allowance, writeContractAsync, stateRes],
  );

  return {
    configured: isV1ClaimConfigured,
    isInSnapshot: Boolean(entry),
    holders,
    loadError,
    snapshotBalance,
    ethAmount,
    burned,
    remaining,
    claimedEth,
    fullyClaimed,
    deadline,
    deadlinePassed,
    v1Balance,
    phase,
    txHash,
    error,
    claim,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}
