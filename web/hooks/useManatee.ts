"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { decodeEventLog, type Address } from "viem";
import { MANATEE_ADDRESS, isManateeConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import { useInvalidateChainReads } from "@/hooks/useInvalidateChainReads";

const CHAIN_ID = activeChain.id;

// Minimal ABI for the mint UI. Kept in sync with
// contracts/src/manatee/BallastManatee.sol.
export const ballastManateeAbi = [
  { type: "function", name: "MAX_SUPPLY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "hasMinted", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "tokenSVG", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "Minted",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

export type MintPhase = "idle" | "minting" | "success" | "error";

export type ManateeState = {
  configured: boolean;
  isLoading: boolean;
  minted?: number; // totalSupply
  maxSupply: number; // 1000
  soldOut: boolean;
  /** Whether the connected wallet has already minted. */
  hasMinted: boolean;
  /** The connected wallet's token id, if known (from event or fresh mint). */
  myTokenId?: number;

  phase: MintPhase;
  txHash?: `0x${string}`;
  error?: string;
  mint: () => Promise<void>;
  reset: () => void;
};

// All figures read live from chain; the counter auto-refreshes via liveQuery so a
// mint elsewhere moves it here too.
export function useManatee(): ManateeState {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const invalidateChainReads = useInvalidateChainReads();

  const reads = useReadContracts({
    allowFailure: true,
    contracts: MANATEE_ADDRESS
      ? ([
          { address: MANATEE_ADDRESS, abi: ballastManateeAbi, functionName: "totalSupply", chainId: CHAIN_ID },
          { address: MANATEE_ADDRESS, abi: ballastManateeAbi, functionName: "MAX_SUPPLY", chainId: CHAIN_ID },
        ] as const)
      : [],
    query: liveQuery(isManateeConfigured),
  });

  // hasMinted(address) is a separate read so the contracts tuple stays static —
  // it only runs once a wallet is connected.
  const mintedByMe = useReadContracts({
    allowFailure: true,
    contracts:
      MANATEE_ADDRESS && address
        ? ([{ address: MANATEE_ADDRESS, abi: ballastManateeAbi, functionName: "hasMinted", args: [address], chainId: CHAIN_ID }] as const)
        : [],
    query: liveQuery(isManateeConfigured && Boolean(address)),
  });

  const pick = (i: number) => (reads.data?.[i]?.status === "success" ? reads.data[i].result : undefined);
  const minted = pick(0) !== undefined ? Number(pick(0)) : undefined;
  const maxSupply = pick(1) !== undefined ? Number(pick(1)) : 1000;
  const hasMintedOnChain =
    address && mintedByMe.data?.[0]?.status === "success" ? Boolean(mintedByMe.data[0].result) : false;
  const soldOut = minted !== undefined && minted >= maxSupply;

  // The connected wallet's token id. Set from a fresh mint immediately; otherwise
  // resolved from the Minted event so a returning holder sees their piece.
  const [myTokenId, setMyTokenId] = useState<number | undefined>();

  useEffect(() => {
    setMyTokenId(undefined);
    if (!publicClient || !MANATEE_ADDRESS || !address || !hasMintedOnChain) return;
    let cancelled = false;
    (async () => {
      try {
        const logs = await publicClient.getContractEvents({
          address: MANATEE_ADDRESS,
          abi: ballastManateeAbi,
          eventName: "Minted",
          args: { to: address },
          fromBlock: "earliest",
          toBlock: "latest",
        });
        if (cancelled) return;
        const id = logs[0]?.args?.tokenId;
        if (id != null) setMyTokenId(Number(id));
      } catch {
        /* leave undefined — the page still shows the "minted" state, art on retry */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, address, hasMintedOnChain]);

  // ── The mint (one write) ────────────────────────────────────────────────
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<MintPhase>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  const mint = useCallback(async () => {
    if (!publicClient || !MANATEE_ADDRESS) return;
    setError(undefined);
    setTxHash(undefined);
    setPhase("minting");
    try {
      const hash = await writeContractAsync({
        address: MANATEE_ADDRESS,
        abi: ballastManateeAbi,
        functionName: "mint",
        chainId: CHAIN_ID,
      });
      setTxHash(hash);
      const outcome = await pollReceipt(publicClient, hash);
      if (outcome.status === "lost") {
        throw new Error(`We lost track of the mint — check Blockscout before retrying: ${hash}`);
      }
      if (outcome.status === "reverted") {
        throw new Error(`The mint reverted — check Blockscout: ${hash}`);
      }
      // Pull the token id straight from the receipt's Minted event, so the art can
      // render immediately without waiting for a log query to catch up.
      for (const log of outcome.receipt.logs) {
        try {
          const parsed = decodeEventLog({ abi: ballastManateeAbi, data: log.data, topics: log.topics });
          if (parsed.eventName === "Minted") {
            setMyTokenId(Number((parsed.args as { tokenId: bigint }).tokenId));
            break;
          }
        } catch {
          /* not our event */
        }
      }
      setPhase("success");
      void reads.refetch();
      void mintedByMe.refetch();
      invalidateChainReads();
    } catch (e) {
      setError(decodeTxError(e));
      setPhase("error");
    }
  }, [publicClient, writeContractAsync, reads, mintedByMe, invalidateChainReads]);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(undefined);
    setTxHash(undefined);
  }, []);

  return {
    configured: isManateeConfigured,
    isLoading: reads.isLoading,
    minted,
    maxSupply,
    soldOut,
    hasMinted: hasMintedOnChain || phase === "success",
    myTokenId,
    phase,
    txHash,
    error,
    mint,
    reset,
  };
}

// Fetch a token's on-chain SVG for display. Deliberately SEPARATE from the mint
// state and run in its own effect with a loading flag: computing the deepest ids
// is a heavier `eth_call`, and it must never block the mint button or the counter.
export function useManateeArt(tokenId: number | undefined): {
  svg?: string;
  loading: boolean;
  error: boolean;
} {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [svg, setSvg] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setSvg(undefined);
    setError(false);
    if (!publicClient || !MANATEE_ADDRESS || tokenId == null) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const s = (await publicClient.readContract({
          address: MANATEE_ADDRESS as Address,
          abi: ballastManateeAbi,
          functionName: "tokenSVG",
          args: [BigInt(tokenId)],
        })) as string;
        if (!cancelled) setSvg(s);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, tokenId]);

  return { svg, loading, error };
}
