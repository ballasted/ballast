"use client";

import { useQuery } from "@tanstack/react-query";
import { INDEXER_URL } from "@/lib/indexer";
import { useIndexerStatus } from "@/hooks/useIndexerStatus";

// Time-series analytics that only the Ponder indexer can produce: 24h volume,
// 24h trades, daily bars. Per the Phase 0 decision these come from Ponder, never
// Dune, and NEVER degrade to a stale or zero value — when the indexer is
// unconfigured / down / delayed the whole series is marked unavailable with a
// reason, and the UI shows "data delayed" + the last indexed time (spec §3.2).
export type DayBar = { day: string; volumeUsd: number; launches: number; trades: number };

export type AnalyticsSeries = {
  available: boolean;
  reason?: "unconfigured" | "down" | "delayed";
  lastIndexedAt?: number;
  volume24hUsd?: number;
  volumePrev24hUsd?: number; // prior period, for the delta
  trades24h?: number;
  tradesPrev24h?: number;
  launches24h?: number;
  daily: DayBar[];
};

// The GraphQL the deployed indexer is expected to expose. Kept here as the single
// contract between app and indexer; building these resolvers is the indexer's job
// (division of labour). Until then the query simply returns nothing and we
// degrade — the app ships honest, not blocked on the indexer.
const QUERY = `query ProtocolAnalytics {
  protocolDayStats(orderBy: "day", orderDirection: "asc", limit: 30) {
    items { day volumeUsd launches trades }
  }
  rolling: protocolRollup(id: "24h") { volumeUsd volumePrev tradesCount tradesPrev launches }
}`;

type RawResponse = {
  data?: {
    protocolDayStats?: { items?: Array<{ day: string | number; volumeUsd: number; launches: number; trades: number }> };
    rolling?: { volumeUsd?: number; volumePrev?: number; tradesCount?: number; tradesPrev?: number; launches?: number } | null;
  };
};

const EMPTY: DayBar[] = [];

export function useAnalyticsSeries(): AnalyticsSeries {
  const status = useIndexerStatus();
  const live = status.state === "live";

  const q = useQuery<AnalyticsSeries>({
    queryKey: ["analytics-series", INDEXER_URL],
    enabled: live,
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await fetch(INDEXER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`indexer ${res.status}`);
      const json = (await res.json()) as RawResponse;
      const items = json.data?.protocolDayStats?.items ?? [];
      const daily: DayBar[] = items.map((it) => ({
        day: String(it.day),
        volumeUsd: Number(it.volumeUsd) || 0,
        launches: Number(it.launches) || 0,
        trades: Number(it.trades) || 0,
      }));
      const r = json.data?.rolling ?? undefined;
      return {
        available: true,
        lastIndexedAt: status.lastIndexedAt,
        volume24hUsd: r?.volumeUsd,
        volumePrev24hUsd: r?.volumePrev,
        trades24h: r?.tradesCount,
        tradesPrev24h: r?.tradesPrev,
        launches24h: r?.launches,
        daily,
      };
    },
  });

  if (!live) {
    return {
      available: false,
      reason: status.state === "unconfigured" ? "unconfigured" : status.state === "delayed" ? "delayed" : "down",
      lastIndexedAt: status.lastIndexedAt,
      daily: EMPTY,
    };
  }
  if (q.data) return q.data;
  // Live but the query failed or hasn't resolved yet — treat as delayed rather
  // than inventing zeros.
  return { available: false, reason: "delayed", lastIndexedAt: status.lastIndexedAt, daily: EMPTY };
}
