"use client";

import { useCallback, useEffect, useState } from "react";
import { useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { BUYBACK_V2_ADDRESS, isBuybackV2Configured, WETH_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import { useInvalidateChainReads } from "@/hooks/useInvalidateChainReads";

const CHAIN_ID = activeChain.id;

// $BALLAST v2's own NVDA quote asset. Kept as a plain constant here (not
// pulled from AssetRegistry) since BuybackBurnerV2 is hardcoded to exactly
// these two assets at construction — see contracts/src/BuybackBurnerV2.sol.
const NVDA_ADDRESS = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;

export const buybackBurnerV2Abi = [
  { type: "function", name: "ballast", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "burnedBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalBallastBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "buybackCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "totalSpent",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "readyAt",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  // Sums held balance + whatever this contract could still pull from its
  // configured hooks (FeeConfig.platformVault's accrued WETH share) — the
  // honest "available for the next WETH buyback" figure, not just balanceOf.
  { type: "function", name: "accruedWeth", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxWethPerCall", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxNvdaPerCall", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cooldownSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // Permissionless: claims this contract's accrued WETH fee share from every
  // configured hook, then buys $BALLAST and burns it. A single call both
  // funds and executes — no separate claim step, no keeper.
  {
    type: "function",
    name: "buybackAndBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
    ],
    outputs: [{ name: "ballastBought", type: "uint256" }],
  },
  {
    type: "event",
    name: "BuybackBurned",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "spent", type: "uint256", indexed: false },
      { name: "ballastBought", type: "uint256", indexed: false },
      { name: "totalBallastBurned", type: "uint256", indexed: false },
    ],
  },
] as const;

export type BurnRowV2 = {
  txHash: `0x${string}`;
  timestamp?: number;
  asset: Address;
  spent: bigint;
  ballastBought: bigint;
};

export type TriggerPhase = "idle" | "triggering" | "success" | "error";

export type BuybackV2State = {
  configured: boolean;
  isLoading: boolean;
  burnedBalance?: bigint; // $BALLAST v2 at DEAD via this contract's own buys
  totalBallastBurned?: bigint;
  buybackCount?: number;
  wethSpent?: bigint;
  nvdaSpent?: bigint;
  wethPendingBalance?: bigint; // held only, not yet claimed from any hook
  nvdaPendingBalance?: bigint;
  wethAccrued?: bigint; // held + still-claimable from configured hooks — the real "available" figure
  wethReadyAt?: bigint; // unix seconds; 0 means ready now
  nvdaReadyAt?: bigint;
  maxWethPerCall?: bigint;

  lastBurn?: BurnRowV2; // most recent BuybackBurned, any asset
  historyError: boolean;

  // The one write most people need: spend up to maxWethPerCall of the
  // accrued WETH (held + claimable) and burn it. Permissionless.
  wethReady: boolean;
  triggerWethPhase: TriggerPhase;
  triggerWethTxHash?: `0x${string}`;
  triggerWethError?: string;
  triggerWeth: () => Promise<void>;
  resetTriggerWeth: () => void;
};

const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Live reads for BuybackBurnerV2 — everything the buyback page's v2 section
 *  needs, all-or-nothing gated on isBuybackV2Configured so the page can show
 *  an honest "manual, not live yet" state until it's deployed. */
export function useBuybackV2(): BuybackV2State {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const stateRes = useReadContracts({
    allowFailure: true,
    contracts: BUYBACK_V2_ADDRESS
      ? ([
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "burnedBalance", chainId: CHAIN_ID },
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "totalBallastBurned", chainId: CHAIN_ID },
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "buybackCount", chainId: CHAIN_ID },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "totalSpent",
            args: [WETH_ADDRESS!],
            chainId: CHAIN_ID,
          },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "totalSpent",
            args: [NVDA_ADDRESS],
            chainId: CHAIN_ID,
          },
          {
            address: WETH_ADDRESS,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [BUYBACK_V2_ADDRESS],
            chainId: CHAIN_ID,
          },
          {
            address: NVDA_ADDRESS,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [BUYBACK_V2_ADDRESS],
            chainId: CHAIN_ID,
          },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "readyAt",
            args: [WETH_ADDRESS!],
            chainId: CHAIN_ID,
          },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "readyAt",
            args: [NVDA_ADDRESS],
            chainId: CHAIN_ID,
          },
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "accruedWeth", chainId: CHAIN_ID },
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "maxWethPerCall", chainId: CHAIN_ID },
        ] as const)
      : [],
    query: liveQuery(isBuybackV2Configured),
  });

  const pick = (i: number) => (stateRes.data?.[i]?.status === "success" ? stateRes.data[i].result : undefined);

  const wethReadyAt = pick(7) as bigint | undefined;
  const wethAccrued = pick(9) as bigint | undefined;
  const maxWethPerCall = pick(10) as bigint | undefined;

  // Most recent BuybackBurned event, any asset — "last burn transaction" with a link.
  const [lastBurn, setLastBurn] = useState<BurnRowV2 | undefined>();
  const [historyError, setHistoryError] = useState(false);

  useEffect(() => {
    if (!publicClient || !BUYBACK_V2_ADDRESS) return;
    let cancelled = false;
    (async () => {
      try {
        const logs = await publicClient.getContractEvents({
          address: BUYBACK_V2_ADDRESS,
          abi: buybackBurnerV2Abi,
          eventName: "BuybackBurned",
          fromBlock: "earliest",
          toBlock: "latest",
        });
        if (cancelled) return;
        if (logs.length === 0) {
          setLastBurn(undefined);
          setHistoryError(false);
          return;
        }
        const latest = logs[logs.length - 1]!;
        const a = latest.args as { asset?: Address; spent?: bigint; ballastBought?: bigint };
        let timestamp: number | undefined;
        try {
          if (latest.blockNumber != null) {
            const blk = await publicClient.getBlock({ blockNumber: latest.blockNumber });
            timestamp = Number(blk.timestamp);
          }
        } catch {
          /* row still shows, dated by tx link only */
        }
        if (cancelled) return;
        setLastBurn({
          txHash: latest.transactionHash as `0x${string}`,
          timestamp,
          asset: (a.asset ?? WETH_ADDRESS) as Address,
          spent: a.spent ?? 0n,
          ballastBought: a.ballastBought ?? 0n,
        });
        setHistoryError(false);
      } catch {
        if (!cancelled) {
          setLastBurn(undefined);
          setHistoryError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  // ── The WETH trigger ──────────────────────────────────────────────────────
  // Permissionless: buybackAndBurn claims this contract's accrued hook-fee
  // share (if any configured hook owes it something) AND spends whatever
  // WETH is held, up to maxWethPerCall, in one call. minAmountOut=0 — the
  // contract's own immutable maxSlippageBps bound still protects the trade
  // regardless of what the caller passes (see BuybackBurnerV2.sol).
  const { writeContractAsync } = useWriteContract();
  const invalidateChainReads = useInvalidateChainReads();
  const [triggerWethPhase, setTriggerWethPhase] = useState<TriggerPhase>("idle");
  const [triggerWethTxHash, setTriggerWethTxHash] = useState<`0x${string}` | undefined>();
  const [triggerWethError, setTriggerWethError] = useState<string | undefined>();

  const now = Math.floor(Date.now() / 1000);
  const wethReady =
    wethAccrued !== undefined &&
    wethAccrued > 0n &&
    (wethReadyAt === undefined || wethReadyAt === 0n || Number(wethReadyAt) <= now);

  const triggerWeth = useCallback(async () => {
    if (!publicClient || !BUYBACK_V2_ADDRESS || !WETH_ADDRESS) return;
    setTriggerWethError(undefined);
    setTriggerWethTxHash(undefined);
    setTriggerWethPhase("triggering");
    try {
      const amountIn = maxWethPerCall ?? (wethAccrued ?? 0n);
      const hash = await writeContractAsync({
        address: BUYBACK_V2_ADDRESS,
        abi: buybackBurnerV2Abi,
        functionName: "buybackAndBurn",
        args: [WETH_ADDRESS, amountIn, 0n],
        chainId: CHAIN_ID,
      });
      setTriggerWethTxHash(hash);
      const outcome = await pollReceipt(publicClient, hash);
      if (outcome.status === "lost") {
        throw new Error(`We lost track of the buyback — check Blockscout before retrying: ${hash}`);
      }
      if (outcome.status === "reverted") {
        throw new Error(`The buyback reverted — check Blockscout: ${hash}`);
      }
      setTriggerWethPhase("success");
      void stateRes.refetch();
      invalidateChainReads();
    } catch (e) {
      setTriggerWethError(decodeTxError(e));
      setTriggerWethPhase("error");
    }
  }, [publicClient, writeContractAsync, stateRes, invalidateChainReads, maxWethPerCall, wethAccrued]);

  const resetTriggerWeth = useCallback(() => {
    setTriggerWethPhase("idle");
    setTriggerWethError(undefined);
    setTriggerWethTxHash(undefined);
  }, []);

  return {
    configured: isBuybackV2Configured,
    isLoading: stateRes.isLoading,
    burnedBalance: pick(0) as bigint | undefined,
    totalBallastBurned: pick(1) as bigint | undefined,
    buybackCount: pick(2) !== undefined ? Number(pick(2)) : undefined,
    wethSpent: pick(3) as bigint | undefined,
    nvdaSpent: pick(4) as bigint | undefined,
    wethPendingBalance: pick(5) as bigint | undefined,
    nvdaPendingBalance: pick(6) as bigint | undefined,
    wethAccrued,
    wethReadyAt,
    nvdaReadyAt: pick(8) as bigint | undefined,
    maxWethPerCall,
    lastBurn,
    historyError,
    wethReady,
    triggerWethPhase,
    triggerWethTxHash,
    triggerWethError,
    triggerWeth,
    resetTriggerWeth,
  };
}
