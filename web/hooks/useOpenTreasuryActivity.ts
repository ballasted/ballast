"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Log } from "viem";
import { openTreasuryVaultAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { backfillLogs } from "@/lib/eventBackfill";
import { DAY_BLOCKS } from "@/lib/liveRail";

const CHAIN_ID = activeChain.id;
const WEEK_BLOCKS = DAY_BLOCKS * 7n;
const MONTH_BLOCKS = DAY_BLOCKS * 30n;

export type ContributorEvent = {
  kind: "deposit" | "withdraw";
  depositor: Address;
  asset: Address;
  amount: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
};

type DepositedLog = Log & { args: { depositor: Address; asset: Address; amount: bigint } };
type WithdrawnLog = Log & { args: { depositor: Address; asset: Address; amount: bigint } };
type RewardAddedLog = Log & { args: { amount: bigint } };

/**
 * Contributor activity + net 24h/7d flow + trailing reward totals for APR,
 * all from events (rule 18 / Phase 5 brief) — a ~30-day getLogs backfill, no
 * indexer (Ponder deferred — see memory). `status` tells the UI whether the
 * backfill actually covered the window or only partially did, so APR/contributor
 * figures can say "Unknown" honestly instead of presenting a partial scan as complete.
 */
export function useOpenTreasuryActivity(vault?: Address) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [events, setEvents] = useState<ContributorEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "partial" | "failed">("idle");
  // Keyed by asset address (lowercased) — summing raw amounts ACROSS different
  // assets/decimals would be meaningless, so net flow is reported per-asset.
  const [net24h, setNet24h] = useState<Record<string, { deposited: bigint; withdrawn: bigint }>>({});
  const [net7d, setNet7d] = useState<Record<string, { deposited: bigint; withdrawn: bigint }>>({});
  const [rewardLast7d, setRewardLast7d] = useState<bigint>();
  const [rewardLast30d, setRewardLast30d] = useState<bigint>();

  useEffect(() => {
    if (!publicClient || !vault) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const fromMonth = latest > MONTH_BLOCKS ? latest - MONTH_BLOCKS : 0n;
        const fromWeek = latest > WEEK_BLOCKS ? latest - WEEK_BLOCKS : 0n;
        const fromDay = latest > DAY_BLOCKS ? latest - DAY_BLOCKS : 0n;

        const [depositedOutcome, withdrawnOutcome, rewardOutcome] = await Promise.all([
          backfillLogs(publicClient, {
            address: vault,
            event: getAbiItem({ abi: openTreasuryVaultAbi, name: "Deposited" }),
            fromBlock: fromMonth,
            toBlock: latest,
          }),
          backfillLogs(publicClient, {
            address: vault,
            event: getAbiItem({ abi: openTreasuryVaultAbi, name: "Withdrawn" }),
            fromBlock: fromMonth,
            toBlock: latest,
          }),
          backfillLogs(publicClient, {
            address: vault,
            event: getAbiItem({ abi: openTreasuryVaultAbi, name: "RewardAdded" }),
            fromBlock: fromMonth,
            toBlock: latest,
          }),
        ]);
        if (cancelled) return;

        const deposits = depositedOutcome.logs as DepositedLog[];
        const withdrawals = withdrawnOutcome.logs as WithdrawnLog[];
        const rewards = rewardOutcome.logs as RewardAddedLog[];

        const combined: ContributorEvent[] = [
          ...deposits.map((l) => ({
            kind: "deposit" as const,
            depositor: l.args.depositor,
            asset: l.args.asset,
            amount: l.args.amount,
            blockNumber: l.blockNumber ?? 0n,
            txHash: l.transactionHash ?? ("0x" as `0x${string}`),
          })),
          ...withdrawals.map((l) => ({
            kind: "withdraw" as const,
            depositor: l.args.depositor,
            asset: l.args.asset,
            amount: l.args.amount,
            blockNumber: l.blockNumber ?? 0n,
            txHash: l.transactionHash ?? ("0x" as `0x${string}`),
          })),
        ].sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0));
        setEvents(combined);

        const netByAsset = (
          deps: DepositedLog[],
          withs: WithdrawnLog[],
          sinceBlock: bigint,
        ): Record<string, { deposited: bigint; withdrawn: bigint }> => {
          const out: Record<string, { deposited: bigint; withdrawn: bigint }> = {};
          const bump = (asset: Address, field: "deposited" | "withdrawn", amount: bigint) => {
            const key = asset.toLowerCase();
            out[key] ??= { deposited: 0n, withdrawn: 0n };
            out[key]![field] += amount;
          };
          deps.filter((l) => (l.blockNumber ?? 0n) >= sinceBlock).forEach((l) => bump(l.args.asset, "deposited", l.args.amount));
          withs.filter((l) => (l.blockNumber ?? 0n) >= sinceBlock).forEach((l) => bump(l.args.asset, "withdrawn", l.args.amount));
          return out;
        };
        setNet24h(netByAsset(deposits, withdrawals, fromDay));
        setNet7d(netByAsset(deposits, withdrawals, fromWeek));

        const r7 = rewards.filter((l) => (l.blockNumber ?? 0n) >= fromWeek).reduce((s, l) => s + l.args.amount, 0n);
        const r30 = rewards.reduce((s, l) => s + l.args.amount, 0n); // already windowed to fromMonth..latest
        setRewardLast7d(r7);
        setRewardLast30d(r30);

        const statuses = [depositedOutcome.status, withdrawnOutcome.status, rewardOutcome.status];
        setStatus(statuses.includes("failed") ? "failed" : statuses.includes("partial") ? "partial" : "ok");
      } catch {
        if (!cancelled) setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, vault]);

  return { events, status, net24h, net7d, rewardLast7d, rewardLast30d };
}
