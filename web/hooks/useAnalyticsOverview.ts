"use client";

import { useEffect, useState } from "react";

// Consolidated protocol-wide Analytics payload from the on-chain indexer
// (/api/indexer/read/overview). `available:false` → the page keeps its
// GeckoTerminal fallback for the top-line KPIs rather than showing fake zeros.

export type OverviewDay = { day: string; volumeUsd: number; trades: number; launches: number; burnedTokens: number };

export type OverviewBuybackRun = {
  burner: string;
  asset: string | null;
  amountIn: number;
  ballastBought: number;
  ts: number;
  tx: string;
};

export type Overview = {
  available: boolean;
  stats?: { launchesTotal: number; tradesTotal: number; volumeUsdAll: number; volume24hUsd: number; trades24h: number };
  series?: OverviewDay[];
  fee?: {
    feeBps: number;
    creatorBps: number | null;
    platformBps: number | null;
    volumeUsdAll: number;
    feeTotalUsd: number;
    creatorUsd: number | null;
    platformUsd: number | null;
    parentBurnTokens: number;
    buyback: { runs: number; ballastTotal: number; byAsset: { asset: string; amountIn: number; ballastBought: number; symbol: string | null }[] };
  } | null;
  burn?: {
    byToken: { token: string; symbol: string | null; burnedTokens: number }[];
    totalBurned: number;
    buybacks: OverviewBuybackRun[];
  };
  topTokens?: { token: string; symbol: string | null; volumeUsd: number; trades: number }[];
  topCreators?: { creator: string; tokenCount: number; volumeUsd: number; feeUsd: number | null }[];
  families?: { parent: string; routers: string[]; burnedTokens: number }[];
  roundups?: { count: number; ethIn: number; byStock: { stock: string; count: number; stockOut: number; symbol: string | null }[] };
  pairing?: { wethOnly: number; stockAndWeth: number; stockOnly: number; total: number } | null;
  exposure?: { total: number; byStock: { asset: string; exposureUsd: number; symbol: string | null }[] } | null;
  addresses?: {
    feeConfig: string | null;
    buyback: string | null;
    buybackV2: string | null;
    lens: string | null;
    assetRegistry: string | null;
    roundupRouter: string | null;
    dead: string;
  };
};

export function useAnalyticsOverview(): { data: Overview | null; isLoading: boolean; available: boolean } {
  const [data, setData] = useState<Overview | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/indexer/read/overview", { cache: "no-store" });
        const json = (await res.json()) as Overview;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setData({ available: false });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, isLoading, available: Boolean(data?.available) };
}
