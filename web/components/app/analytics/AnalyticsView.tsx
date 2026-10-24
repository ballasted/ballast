"use client";

import { useMemo, useState } from "react";
import { useAnalyticsSeries } from "@/hooks/useAnalyticsSeries";
import { useIndexedAnalytics, useIndexedStats } from "@/hooks/useIndexedStats";
import { useProjects } from "@/hooks/useProjects";
import { useBuybackV2 } from "@/hooks/useBuybackV2";
import { WETH_ADDRESS, isHiddenToken } from "@/lib/contracts";
import { formatUsd, formatTokenAmount } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { Stat } from "@/components/ui/Stat";
import { DeltaText } from "@/components/ui/DeltaText";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

type Range = "24h" | "7d" | "30d" | "All";
const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30, All: 3650 };

// Plain-number USD (GeckoTerminal gives numbers, not 1e18). formatUsd is for
// 1e18-scaled values, so keep this separate.
function usdCompact(n?: number): string | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function AnalyticsView() {
  const [range, setRange] = useState<Range>("7d");
  const series = useAnalyticsSeries();
  // Prefer our own indexer for the volume series + headline once backfilled; fall
  // back to GeckoTerminal until then (available=false while the DB is empty).
  const idxAnalytics = useIndexedAnalytics(365);
  const idxStats = useIndexedStats();
  // Only prefer the indexer for volume once it has actually indexed SWAPS —
  // `available` is true as soon as launches are indexed, so without this gate the
  // indexer's $0 volume would mask real GeckoTerminal volume.
  const indexerHasTrades = idxStats.available && (idxStats.stats?.tradesTotal ?? 0) > 0;
  const vol24 = indexerHasTrades && idxStats.stats ? idxStats.stats.volume24hUsd : series.volume24hUsd;
  const { projects, count, isLoading: projLoading } = useProjects();
  const buyback = useBuybackV2();

  const listed = useMemo(() => projects.filter((p) => !isHiddenToken(p.token)), [projects]);

  // Stock backing across treasuries (sum of locked backing value, 1e18 USD).
  const backing1e18 = useMemo(
    () => listed.reduce((acc, p) => acc + (p.backing?.lockedValueUsd ?? 0n), 0n),
    [listed],
  );
  const backingKnown = listed.some((p) => p.backing !== undefined);

  // Pairing mix — classified from real quoteAssetsOf (exact, on-chain).
  const pairing = useMemo(() => {
    const weth = WETH_ADDRESS?.toLowerCase();
    let wethOnly = 0;
    let stockWeth = 0;
    let stockOnly = 0;
    for (const p of listed) {
      const qs = p.quoteAssets.map((a) => a.toLowerCase());
      const hasWeth = weth ? qs.includes(weth) : false;
      const hasStock = qs.some((a) => a !== weth);
      if (hasWeth && hasStock) stockWeth++;
      else if (hasWeth) wethOnly++;
      else stockOnly++;
    }
    const total = wethOnly + stockWeth + stockOnly;
    return { wethOnly, stockWeth, stockOnly, total };
  }, [listed]);

  // Volume bars for the selected range.
  const bars = useMemo(() => {
    const src = indexerHasTrades && idxAnalytics.available ? idxAnalytics.days : series.daily;
    const d = [...src].sort((a, b) => a.day.localeCompare(b.day));
    return d.slice(-RANGE_DAYS[range]);
  }, [indexerHasTrades, idxAnalytics.available, idxAnalytics.days, series.daily, range]);
  const maxVol = useMemo(() => Math.max(1, ...bars.map((b) => b.volumeUsd)), [bars]);

  const volDelta =
    series.volume24hUsd !== undefined && series.volumePrev24hUsd && series.volumePrev24hUsd > 0
      ? ((series.volume24hUsd - series.volumePrev24hUsd) / series.volumePrev24hUsd) * 100
      : undefined;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-serif text-display-sm text-text-primary">Analytics</h1>
          <p className="text-sm text-text-muted">Everything on Ballast, read straight from Robinhood Chain.</p>
        </div>
        <Segmented
          ariaLabel="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: "24h", label: "24h" },
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
            { value: "All", label: "All" },
          ]}
        />
      </header>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Card>
          <Stat
            label="Volume · 24h"
            value={series.isLoading ? <Skeleton height={24} width="70%" /> : (usdCompact(vol24) ?? "—")}
            sub={volDelta !== undefined ? <DeltaText value={volDelta} suffix="% vs prev" /> : undefined}
          />
        </Card>
        <Card>
          <Stat
            label="Trades · 24h"
            value={
              series.isLoading ? (
                <Skeleton height={24} width="60%" />
              ) : series.trades24h !== undefined ? (
                series.trades24h.toLocaleString("en-US")
              ) : (
                "—"
              )
            }
          />
        </Card>
        <Card>
          <Stat
            label="Launches"
            value={projLoading ? <Skeleton height={24} width="50%" /> : count.toLocaleString("en-US")}
            sub="all-time"
          />
        </Card>
        <Card>
          <Stat
            label="$BALLAST sent to dead address"
            value={
              !buyback.configured ? (
                "—"
              ) : buyback.burnedBalance === undefined ? (
                <Skeleton height={24} width="70%" />
              ) : (
                formatTokenAmount(buyback.burnedBalance)
              )
            }
            sub={
              buyback.configured && buyback.buybackCount !== undefined
                ? `${buyback.buybackCount} buyback${buyback.buybackCount === 1 ? "" : "s"}`
                : "not live yet"
            }
          />
        </Card>
        <Card>
          <Stat
            label="Stock backing"
            value={projLoading ? <Skeleton height={24} width="70%" /> : backingKnown ? formatUsd(backing1e18, { compact: true }) : "—"}
            sub="across treasuries"
          />
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {/* Volume bar chart */}
        <Card className="lg:col-span-2">
          <div className="mb-4 flex items-baseline justify-between">
            <div>
              <div className="text-ui-xs text-text-muted">Volume · {range}</div>
              <div className="mt-1 text-ui-xl font-semibold tabular-nums text-text-primary">
                {series.isLoading ? <Skeleton height={28} width={120} /> : (usdCompact(vol24) ?? "—")}
              </div>
            </div>
          </div>
          {series.isLoading ? (
            <Skeleton height={200} />
          ) : bars.length > 0 ? (
            <div className="flex h-[200px] items-end gap-1">
              {bars.map((b, i) => (
                <div
                  key={b.day}
                  title={`${b.day} · ${usdCompact(b.volumeUsd) ?? "$0"}`}
                  className={cn(
                    "min-w-0 flex-1 rounded-t-sm transition-colors",
                    i === bars.length - 1 ? "bg-up" : "bg-green-mid/70",
                  )}
                  style={{ height: `${Math.max(2, (b.volumeUsd / maxVol) * 100)}%` }}
                />
              ))}
            </div>
          ) : (
            <div className="flex h-[200px] items-center justify-center text-sm text-text-muted">
              {series.available ? "No volume in range" : "Volume unavailable"}
            </div>
          )}
        </Card>

        {/* Pairing mix */}
        <Card>
          <div className="mb-1 text-ui-md font-semibold text-text-primary">Pairing mix</div>
          <p className="mb-4 text-ui-xs text-text-muted">Launches by quote asset</p>
          {projLoading ? (
            <div className="space-y-3">
              <Skeleton height={14} />
              <Skeleton height={14} />
              <Skeleton height={14} />
            </div>
          ) : pairing.total > 0 ? (
            <div className="space-y-3">
              <PairBar label="WETH only" n={pairing.wethOnly} total={pairing.total} color="bg-up" />
              <PairBar label="Stock + WETH" n={pairing.stockWeth} total={pairing.total} color="bg-creator-accent" />
              <PairBar label="Stock only" n={pairing.stockOnly} total={pairing.total} color="bg-backing" />
            </div>
          ) : (
            <div className="text-sm text-text-muted">No launches yet</div>
          )}
        </Card>
      </div>

      <p className="text-ui-xs text-text-faint">
        Fee flows, token families and per-stock exposure arrive with the on-chain indexer. Burns can be zero.
      </p>
    </div>
  );
}

function PairBar({ label, n, total, color }: { label: string; n: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-ui-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="tabular-nums text-text-muted">
          {n} · {pct}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.04]">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
