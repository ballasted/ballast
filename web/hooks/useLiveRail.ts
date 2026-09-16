"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Log } from "viem";
import { ballastFactoryAbi, poolManagerAbi } from "@/lib/abis";
import { buybackBurnerAbi } from "./useBuyback";
import {
  FACTORY_ADDRESSES,
  BUYBACK_ADDRESS,
  POOL_MANAGER_ADDRESS,
  isBuybackConfigured,
  isSwapConfigured,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { candidatePoolKeys } from "@/lib/pool";
import { backfillLogs, type BackfillOutcome } from "@/lib/eventBackfill";
import { useEthUsd } from "./useEthUsd";
import type { Project } from "./useProjects";
import {
  DAY_BLOCKS,
  LARGE_BUY_USD_THRESHOLD,
  RAIL_MAX_EVENTS,
  classifySwap,
  swapUsdSize,
  type RailEvent,
} from "@/lib/liveRail";

const CHAIN_ID = activeChain.id;

export type LiveRailStatus = "loading" | "ready" | "partial" | "unavailable";

/**
 * Live protocol feed (spec §5.6): launches, graduations, burns, large buys.
 * Reserve-state changes are dropped — no discrete on-chain event exists for
 * that category (Milestone 1 decision: freshness is a computed tier, not an
 * event).
 *
 * Backfills a ~24h window on mount (getLogs, chunked-fallback via
 * lib/eventBackfill), then hands off to watchContractEvent for the rest of
 * the session. `status` tells the UI whether the backfill actually covered
 * history ("ready"/"partial") or failed outright ("unavailable" — the rail
 * still works, but must say "live from now", not imply it's history).
 */
export function useLiveRail(projects: Project[]) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { ethUsd1e18 } = useEthUsd();
  const [events, setEvents] = useState<RailEvent[]>([]);
  const [status, setStatus] = useState<LiveRailStatus>("loading");
  const seenKeys = useRef(new Set<string>());
  const ethUsdRef = useRef(ethUsd1e18);
  ethUsdRef.current = ethUsd1e18;

  const poolIndex = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) {
      for (const cand of candidatePoolKeys(p.token)) m.set(cand.id.toLowerCase(), p);
    }
    return m;
  }, [projects]);
  const byToken = useMemo(
    () => new Map(projects.map((p) => [p.token.toLowerCase(), p] as const)),
    [projects],
  );

  const pushEvents = useCallback((incoming: RailEvent[]) => {
    if (incoming.length === 0) return;
    setEvents((prev) => {
      const merged = [...prev];
      for (const e of incoming) {
        if (seenKeys.current.has(e.key)) continue;
        seenKeys.current.add(e.key);
        merged.push(e);
      }
      merged.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0));
      return merged.slice(0, RAIL_MAX_EVENTS);
    });
  }, []);

  // ── Backfill ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    let settled = false;

    // No overall timeout here would mean a fully-unreachable RPC can leave the
    // rail on its loading skeleton for as long as the transport's own
    // retry/timeout stack takes to exhaust across every one of these calls
    // (observed: minutes, not seconds, when every attempt fails) — worse than
    // just saying "live from now" and moving on. This doesn't cancel the real
    // backfill; if it finishes late and actually found something, it still
    // upgrades the rail from "unavailable" to real history.
    const BACKFILL_TIMEOUT_MS = 20_000;
    const timeoutId = setTimeout(() => {
      if (!cancelled && !settled) setStatus("unavailable");
    }, BACKFILL_TIMEOUT_MS);

    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const fromBlock = latest > DAY_BLOCKS ? latest - DAY_BLOCKS : 0n;
        const outcomes: BackfillOutcome[] = [];

        const launchedLogs: Log[] = [];
        const graduatedLogs: Log[] = [];
        for (const factory of FACTORY_ADDRESSES) {
          const [launched, graduated] = await Promise.all([
            backfillLogs(publicClient, {
              address: factory,
              event: getAbiItem({ abi: ballastFactoryAbi, name: "Launched" }),
              fromBlock,
              toBlock: latest,
            }),
            backfillLogs(publicClient, {
              address: factory,
              event: getAbiItem({ abi: ballastFactoryAbi, name: "Graduated" }),
              fromBlock,
              toBlock: latest,
            }),
          ]);
          outcomes.push(launched, graduated);
          launchedLogs.push(...launched.logs);
          graduatedLogs.push(...graduated.logs);
        }

        let burnedLogs: Log[] = [];
        if (isBuybackConfigured && BUYBACK_ADDRESS) {
          const burned = await backfillLogs(publicClient, {
            address: BUYBACK_ADDRESS,
            event: getAbiItem({ abi: buybackBurnerAbi, name: "BuybackBurned" }),
            fromBlock,
            toBlock: latest,
          });
          outcomes.push(burned);
          burnedLogs = burned.logs;
        }

        let swapLogs: Log[] = [];
        if (isSwapConfigured && POOL_MANAGER_ADDRESS) {
          const swaps = await backfillLogs(publicClient, {
            address: POOL_MANAGER_ADDRESS,
            event: getAbiItem({ abi: poolManagerAbi, name: "Swap" }),
            fromBlock,
            toBlock: latest,
          });
          outcomes.push(swaps);
          swapLogs = swaps.logs;
        }

        if (cancelled) return;

        const decoded = await decodeAll(
          publicClient,
          { launchedLogs, graduatedLogs, burnedLogs, swapLogs },
          poolIndex,
          byToken,
          ethUsdRef.current,
        );
        if (cancelled) return;
        pushEvents(decoded);

        const anyOk = outcomes.some((o) => o.status !== "failed");
        const allOk = outcomes.every((o) => o.status === "ok");
        settled = true;
        clearTimeout(timeoutId);
        setStatus(outcomes.length === 0 ? "unavailable" : allOk ? "ready" : anyOk ? "partial" : "unavailable");
      } catch {
        settled = true;
        clearTimeout(timeoutId);
        if (!cancelled) setStatus("unavailable");
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    // poolIndex intentionally excluded: it's derived from `projects`, which is
    // stable in identity often enough that re-running the whole backfill on
    // every project-list refresh would be wasteful; watch below stays live
    // regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, pushEvents]);

  // ── Live watch (handoff after backfill) ──────────────────────────────────
  useEffect(() => {
    if (!publicClient) return;
    const unwatchers: Array<() => void> = [];

    for (const factory of FACTORY_ADDRESSES) {
      unwatchers.push(
        publicClient.watchContractEvent({
          address: factory,
          abi: ballastFactoryAbi,
          eventName: "Launched",
          onLogs: (logs) =>
            void handleLive(publicClient, "LAUNCH", logs, poolIndex, byToken, ethUsdRef.current, pushEvents),
        }),
      );
      unwatchers.push(
        publicClient.watchContractEvent({
          address: factory,
          abi: ballastFactoryAbi,
          eventName: "Graduated",
          onLogs: (logs) =>
            void handleLive(publicClient, "GRADUATED", logs, poolIndex, byToken, ethUsdRef.current, pushEvents),
        }),
      );
    }
    if (isBuybackConfigured && BUYBACK_ADDRESS) {
      unwatchers.push(
        publicClient.watchContractEvent({
          address: BUYBACK_ADDRESS,
          abi: buybackBurnerAbi,
          eventName: "BuybackBurned",
          onLogs: (logs) =>
            void handleLive(publicClient, "BURN", logs, poolIndex, byToken, ethUsdRef.current, pushEvents),
        }),
      );
    }
    if (isSwapConfigured && POOL_MANAGER_ADDRESS) {
      unwatchers.push(
        publicClient.watchContractEvent({
          address: POOL_MANAGER_ADDRESS,
          abi: poolManagerAbi,
          eventName: "Swap",
          onLogs: (logs) =>
            void handleLive(publicClient, "BUY", logs, poolIndex, byToken, ethUsdRef.current, pushEvents),
        }),
      );
    }

    return () => unwatchers.forEach((u) => u());
  }, [publicClient, poolIndex, byToken, pushEvents]);

  return { events, status };
}

async function handleLive(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  kind: RailEvent["kind"],
  logs: Log[],
  poolIndex: Map<string, Project>,
  byToken: Map<string, Project>,
  ethUsd1e18: bigint | undefined,
  push: (e: RailEvent[]) => void,
) {
  const decoded = await decodeAll(
    client,
    {
      launchedLogs: kind === "LAUNCH" ? logs : [],
      graduatedLogs: kind === "GRADUATED" ? logs : [],
      burnedLogs: kind === "BURN" ? logs : [],
      swapLogs: kind === "BUY" ? logs : [],
    },
    poolIndex,
    byToken,
    ethUsd1e18,
  );
  push(decoded);
}

async function decodeAll(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  logs: { launchedLogs: Log[]; graduatedLogs: Log[]; burnedLogs: Log[]; swapLogs: Log[] },
  poolIndex: Map<string, Project>,
  byToken: Map<string, Project>,
  ethUsd1e18: bigint | undefined,
): Promise<RailEvent[]> {
  const out: RailEvent[] = [];

  for (const l of logs.launchedLogs) {
    const args = (l as unknown as { args: { token?: Address } }).args;
    const project = args?.token ? byToken.get(args.token.toLowerCase()) : undefined;
    out.push(rowFor("LAUNCH", l, { token: args?.token, symbol: project?.symbol }));
  }
  for (const l of logs.graduatedLogs) {
    const args = (l as unknown as { args: { token?: Address } }).args;
    const project = args?.token ? byToken.get(args.token.toLowerCase()) : undefined;
    out.push(rowFor("GRADUATED", l, { token: args?.token, symbol: project?.symbol }));
  }
  for (const l of logs.burnedLogs) {
    const args = (l as unknown as { args: { wethSpent?: bigint } }).args;
    const amountUsd =
      args?.wethSpent !== undefined && ethUsd1e18 !== undefined
        ? (Number(args.wethSpent) / 1e18) * (Number(ethUsd1e18) / 1e18)
        : undefined;
    out.push(rowFor("BURN", l, { amountUsd }));
  }
  for (const l of logs.swapLogs) {
    const args = (l as unknown as { args: { id?: `0x${string}`; amount1?: bigint } }).args;
    if (args?.id === undefined || args.amount1 === undefined || ethUsd1e18 === undefined) continue;
    const project = poolIndex.get(args.id.toLowerCase());
    if (!project) continue; // not one of ours — skip rather than show an unlabeled row
    if (classifySwap(args.amount1) !== "buy") continue; // large BUYS only, per spec
    const amountUsd = swapUsdSize(args.amount1, ethUsd1e18);
    if (amountUsd < LARGE_BUY_USD_THRESHOLD) continue;
    out.push(rowFor("BUY", l, { token: project.token, symbol: project.symbol, amountUsd }));
  }

  // Resolve block timestamps for whatever we decoded — same batched pattern
  // useBuyback's history effect already uses.
  const blocks = [...new Set(out.map((e) => e.blockNumber))];
  if (blocks.length > 0) {
    const times = new Map<bigint, number>();
    await Promise.all(
      blocks.map(async (b) => {
        try {
          const blk = await client.getBlock({ blockNumber: b });
          times.set(b, Number(blk.timestamp));
        } catch {
          /* row still shows, just without a relative time */
        }
      }),
    );
    for (const e of out) e.timestamp = times.get(e.blockNumber);
  }

  return out;
}

function rowFor(
  kind: RailEvent["kind"],
  log: Log,
  extra: { token?: Address; symbol?: string; amountUsd?: number },
): RailEvent {
  return {
    kind,
    key: `${log.transactionHash}-${log.logIndex}`,
    txHash: log.transactionHash as `0x${string}`,
    blockNumber: log.blockNumber as bigint,
    ...extra,
  };
}
