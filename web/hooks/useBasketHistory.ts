"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Log } from "viem";
import { basketZapAbi } from "@/lib/basketZapAbi";
import { BASKET_ZAP_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { backfillLogs } from "@/lib/eventBackfill";
import { DAY_BLOCKS } from "@/lib/liveRail";

const CHAIN_ID = activeChain.id;
const MONTH_BLOCKS = DAY_BLOCKS * 30n;

export type BasketLegRecord = { asset: Address; weightBps: number; amountOut: bigint };
export type BasketSwap = { ethIn: bigint; ethRefunded: bigint; legs: BasketLegRecord[]; blockNumber: bigint; txHash: `0x${string}` };

type BasketSwappedLog = Log & {
  args: { launchToken: Address; creator: Address; ethIn: bigint; ethRefunded: bigint; assets: Address[]; weightsBps: number[]; amountsOut: bigint[] };
};

/** This launch's BasketZap history — same ~30-day getLogs backfill convention
 *  as useOpenTreasuryActivity (no indexer; Ponder deferred, see memory). There
 *  is no separate on-chain "basket" concept — a basket leg is an ordinary
 *  treasury deposit once the creator calls deposit() — so "weights at deposit"
 *  can only be reconstructed from this event log, not from current treasury
 *  state. `status` lets the card say "partial history" honestly rather than
 *  presenting an incomplete scan as the full basket. */
export function useBasketHistory(launchToken?: Address) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [swaps, setSwaps] = useState<BasketSwap[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "partial" | "failed">("idle");

  useEffect(() => {
    if (!publicClient || !launchToken || !BASKET_ZAP_ADDRESS) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    (async () => {
      const latest = await publicClient.getBlockNumber();
      const fromBlock = latest > MONTH_BLOCKS ? latest - MONTH_BLOCKS : 0n;
      const outcome = await backfillLogs(publicClient, {
        address: BASKET_ZAP_ADDRESS,
        event: getAbiItem({ abi: basketZapAbi, name: "BasketSwapped" }),
        fromBlock,
        toBlock: latest,
      });
      if (cancelled) return;
      const mine = (outcome.logs as BasketSwappedLog[]).filter(
        (l) => l.args.launchToken?.toLowerCase() === launchToken.toLowerCase(),
      );
      setSwaps(
        mine.map((l) => ({
          ethIn: l.args.ethIn,
          ethRefunded: l.args.ethRefunded,
          legs: l.args.assets.map((asset, i) => ({ asset, weightBps: l.args.weightsBps[i]!, amountOut: l.args.amountsOut[i]! })),
          blockNumber: l.blockNumber!,
          txHash: l.transactionHash!,
        })),
      );
      setStatus(outcome.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, launchToken]);

  return { swaps, status, hasHistory: swaps.length > 0 };
}
