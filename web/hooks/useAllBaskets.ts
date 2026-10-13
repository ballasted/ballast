"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Log } from "viem";
import { basketZapAbi } from "@/lib/basketZapAbi";
import { BASKET_ZAP_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { backfillLogs } from "@/lib/eventBackfill";
import { DAY_BLOCKS } from "@/lib/liveRail";
import { retryRead } from "@/lib/retryRead";
import type { BasketSwap } from "./useBasketHistory";

const CHAIN_ID = activeChain.id;
const MONTH_BLOCKS = DAY_BLOCKS * 30n;

type BasketSwappedLog = Log & {
  args: {
    launchToken: Address;
    creator: Address;
    ethIn: bigint;
    ethRefunded: bigint;
    assets: Address[];
    weightsBps: number[];
    amountsOut: bigint[];
  };
};

/**
 * Every BasketZap `BasketSwapped` event in the ~30-day window, grouped by launch
 * token — ONE getLogs scan for the whole baskets directory. useBasketHistory
 * does the same scan but filters to a single token client-side, so calling IT
 * per-row would re-scan the identical logs N times; this reads them once and
 * buckets by token. Status is surfaced so the page can say "partial history"
 * honestly rather than presenting an incomplete scan as complete.
 */
export function useAllBaskets() {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [byToken, setByToken] = useState<Map<string, BasketSwap[]>>(new Map());
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "partial" | "failed">("idle");

  useEffect(() => {
    if (!publicClient || !BASKET_ZAP_ADDRESS) {
      setStatus("idle");
      return;
    }
    const zapAddress = BASKET_ZAP_ADDRESS;
    let cancelled = false;
    setStatus("loading");
    (async () => {
      const latest = await retryRead(() => publicClient.getBlockNumber());
      const fromBlock = latest > MONTH_BLOCKS ? latest - MONTH_BLOCKS : 0n;
      const outcome = await retryRead(async () => {
        const result = await backfillLogs(publicClient, {
          address: zapAddress,
          event: getAbiItem({ abi: basketZapAbi, name: "BasketSwapped" }),
          fromBlock,
          toBlock: latest,
        });
        if (result.status === "failed") throw new Error("backfillLogs failed");
        return result;
      }).catch(() => ({ logs: [], status: "failed" as const }));
      if (cancelled) return;
      const m = new Map<string, BasketSwap[]>();
      for (const l of outcome.logs as BasketSwappedLog[]) {
        const token = l.args.launchToken?.toLowerCase();
        if (!token) continue;
        const swap: BasketSwap = {
          ethIn: l.args.ethIn,
          ethRefunded: l.args.ethRefunded,
          legs: l.args.assets.map((asset, i) => ({ asset, weightBps: l.args.weightsBps[i]!, amountOut: l.args.amountsOut[i]! })),
          blockNumber: l.blockNumber!,
          txHash: l.transactionHash!,
        };
        const existing = m.get(token);
        if (existing) existing.push(swap);
        else m.set(token, [swap]);
      }
      setByToken(m);
      setStatus(outcome.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  return { byToken, status, tokens: [...byToken.keys()] };
}
