"use client";

import { useCallback, useEffect, useState } from "react";
import { useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { erc20Abi } from "@/lib/abis";
import { BUYBACK_ADDRESS, isBuybackConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import { useInvalidateChainReads } from "@/hooks/useInvalidateChainReads";

const CHAIN_ID = activeChain.id;

// Minimal ABI for the BuybackBurner reads + its event. Kept in sync with
// contracts/src/BuybackBurner.sol.
export const buybackBurnerAbi = [
  { type: "function", name: "ballast", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "totalBallastBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalWethSpent", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "buybackCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "threshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSlippageBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "accruedWeth", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "burnedBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // The one write: permissionless, threshold-gated. Anyone may call it; it claims the
  // accrued WETH, buys $BALLAST through the pool, and burns it. Returns the amount burned.
  {
    type: "function",
    name: "buybackAndBurn",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "BuybackBurned",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "wethSpent", type: "uint256", indexed: false },
      { name: "ballastBought", type: "uint256", indexed: false },
      { name: "ballastBurned", type: "uint256", indexed: false },
      { name: "totalWethSpent", type: "uint256", indexed: false },
      { name: "totalBallastBurned", type: "uint256", indexed: false },
    ],
  },
] as const;

export type BurnRow = {
  txHash: `0x${string}`;
  timestamp?: number; // unix seconds; undefined if the block read failed
  wethSpent: bigint;
  ballastBought: bigint;
  effectivePriceWeth?: bigint; // WETH per $BALLAST, 1e18
};

export type BuybackState = {
  configured: boolean;
  isLoading: boolean;
  ballast?: Address;
  totalBurned?: bigint; // from the dead-address balance — independently verifiable
  totalBurnedFromCounter?: bigint; // the contract's own cumulative counter
  totalSupply?: bigint;
  burnedPctBps?: number; // burned / supply, in bps
  totalWethSpent?: bigint;
  accruedWeth?: bigint; // fees accrued but not yet spent
  threshold?: bigint;
  maxSlippageBps?: number;
  buybackCount?: number;
  history: BurnRow[];
  historyError: boolean;

  // Trigger action (the one write). `ready` mirrors the on-chain gate: accrued ≥
  // threshold. Anyone connected may call `trigger` when ready — it is permissionless.
  ready: boolean;
  triggerPhase: TriggerPhase;
  triggerTxHash?: `0x${string}`;
  triggerError?: string;
  trigger: () => Promise<void>;
  resetTrigger: () => void;
};

export type TriggerPhase = "idle" | "triggering" | "success" | "error";

// Everything on this page is read live from chain: the BuybackBurner's state + its
// BuybackBurned event log (the burn history), plus $BALLAST's total supply. The dead
// address balance is the headline burn total, so a reader can verify it without us.
export function useBuyback(): BuybackState {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const stateRes = useReadContracts({
    allowFailure: true,
    contracts: BUYBACK_ADDRESS
      ? ([
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "ballast", chainId: CHAIN_ID },
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "burnedBalance", chainId: CHAIN_ID },
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "totalBallastBurned", chainId: CHAIN_ID },
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "totalWethSpent", chainId: CHAIN_ID },
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "accruedWeth", chainId: CHAIN_ID },
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "threshold", chainId: CHAIN_ID },
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "maxSlippageBps", chainId: CHAIN_ID },
          { address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "buybackCount", chainId: CHAIN_ID },
        ] as const)
      : [],
    query: liveQuery(isBuybackConfigured),
  });

  const pick = (i: number) => (stateRes.data?.[i]?.status === "success" ? stateRes.data[i].result : undefined);
  const ballast = pick(0) as Address | undefined;
  const totalBurned = pick(1) as bigint | undefined;
  const totalBurnedFromCounter = pick(2) as bigint | undefined;
  const totalWethSpent = pick(3) as bigint | undefined;
  const accruedWeth = pick(4) as bigint | undefined;
  const threshold = pick(5) as bigint | undefined;
  const maxSlippageBps = pick(6) !== undefined ? Number(pick(6)) : undefined;
  const buybackCount = pick(7) !== undefined ? Number(pick(7)) : undefined;

  // $BALLAST total supply (for the burned-% and the supply bar).
  const supplyRes = useReadContracts({
    allowFailure: true,
    contracts: ballast
      ? ([{ address: ballast, abi: erc20Abi, functionName: "totalSupply", chainId: CHAIN_ID }] as const)
      : [],
    query: liveQuery(Boolean(ballast)),
  });
  const totalSupply = supplyRes.data?.[0]?.status === "success" ? (supplyRes.data[0].result as bigint) : undefined;
  const burnedPctBps =
    totalBurned !== undefined && totalSupply !== undefined && totalSupply > 0n
      ? Number((totalBurned * 10_000n) / totalSupply)
      : undefined;

  // Burn history from the BuybackBurned event log, newest first, with block times.
  const [history, setHistory] = useState<BurnRow[]>([]);
  const [historyError, setHistoryError] = useState(false);

  useEffect(() => {
    if (!publicClient || !BUYBACK_ADDRESS) return;
    let cancelled = false;
    (async () => {
      try {
        const logs = await publicClient.getContractEvents({
          address: BUYBACK_ADDRESS,
          abi: buybackBurnerAbi,
          eventName: "BuybackBurned",
          fromBlock: "earliest",
          toBlock: "latest",
        });
        // Unique blocks → one getBlock each for timestamps.
        const blocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))];
        const times = new Map<bigint, number>();
        await Promise.all(
          blocks.map(async (b) => {
            try {
              const blk = await publicClient.getBlock({ blockNumber: b });
              times.set(b, Number(blk.timestamp));
            } catch {
              /* leave undefined — the row still shows, dated by tx link */
            }
          }),
        );
        if (cancelled) return;
        const rows: BurnRow[] = logs
          .map((l) => {
            const a = l.args as { wethSpent?: bigint; ballastBought?: bigint };
            const wethSpent = a.wethSpent ?? 0n;
            const ballastBought = a.ballastBought ?? 0n;
            return {
              txHash: l.transactionHash as `0x${string}`,
              timestamp: l.blockNumber != null ? times.get(l.blockNumber) : undefined,
              wethSpent,
              ballastBought,
              effectivePriceWeth: ballastBought > 0n ? (wethSpent * 10n ** 18n) / ballastBought : undefined,
            };
          })
          .reverse(); // newest first
        setHistory(rows);
        setHistoryError(false);
      } catch {
        if (!cancelled) {
          setHistory([]);
          setHistoryError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  // ── The trigger (buybackAndBurn) ──────────────────────────────────────────
  // Permissionless: any connected wallet may call it once accrued ≥ threshold. The
  // caller pays gas and gets nothing back — this is a mechanism, not a reward. On
  // success we refetch the page's reads and invalidate every live query (the buy is
  // a real swap that moves price, the trades feed, and the burn total at once).
  const { writeContractAsync } = useWriteContract();
  const invalidateChainReads = useInvalidateChainReads();
  const [triggerPhase, setTriggerPhase] = useState<TriggerPhase>("idle");
  const [triggerTxHash, setTriggerTxHash] = useState<`0x${string}` | undefined>();
  const [triggerError, setTriggerError] = useState<string | undefined>();

  const ready = threshold !== undefined && accruedWeth !== undefined && accruedWeth >= threshold;

  const trigger = useCallback(async () => {
    if (!publicClient || !BUYBACK_ADDRESS) return;
    setTriggerError(undefined);
    setTriggerTxHash(undefined);
    setTriggerPhase("triggering");
    try {
      const hash = await writeContractAsync({
        address: BUYBACK_ADDRESS,
        abi: buybackBurnerAbi,
        functionName: "buybackAndBurn",
        chainId: CHAIN_ID,
      });
      setTriggerTxHash(hash);
      const outcome = await pollReceipt(publicClient, hash);
      if (outcome.status === "lost") {
        throw new Error(`We lost track of the buyback — check Blockscout before retrying: ${hash}`);
      }
      if (outcome.status === "reverted") {
        throw new Error(`The buyback reverted — check Blockscout: ${hash}`);
      }
      setTriggerPhase("success");
      void stateRes.refetch();
      invalidateChainReads(); // burn total, supply, accrued, price all move at once
    } catch (e) {
      setTriggerError(decodeTxError(e));
      setTriggerPhase("error");
    }
  }, [publicClient, writeContractAsync, stateRes, invalidateChainReads]);

  const resetTrigger = useCallback(() => {
    setTriggerPhase("idle");
    setTriggerError(undefined);
    setTriggerTxHash(undefined);
  }, []);

  return {
    configured: isBuybackConfigured,
    isLoading: stateRes.isLoading,
    ballast,
    totalBurned,
    totalBurnedFromCounter,
    totalSupply,
    burnedPctBps,
    totalWethSpent,
    accruedWeth,
    threshold,
    maxSlippageBps,
    buybackCount,
    history,
    historyError,
    ready,
    triggerPhase,
    triggerTxHash,
    triggerError,
    trigger,
    resetTrigger,
  };
}
