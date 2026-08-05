"use client";

import type { Project } from "@/hooks/useProjects";
import { useAnalyticsSeries } from "@/hooks/useAnalyticsSeries";
import { useProtocolHolders } from "@/hooks/useProtocolHolders";
import { useNow } from "@/hooks/useNow";
import { formatUsd, timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";

// The four headline figures above the Discover board (Phase 3). Total ballast leads
// — backing is our story, and no other launchpad on this chain can show it.
//
// Reconciliation by construction: total ballast and tokens-launched are derived from
// the SAME `projects` array Discover renders below (passed in as a prop, not a
// separate counter), so they can never drift from the list. 24h volume and holders
// come from GeckoTerminal / Blockscout over that same token set. Each card states
// its source and freshness; an unreachable source shows an em dash + "unavailable",
// never a zero — and a genuinely small number (even $0 total ballast) is shown as-is.
export function DiscoverStats({
  projects,
  count,
  isLoading,
}: {
  projects: Project[];
  count: number;
  isLoading: boolean;
}) {
  const now = useNow();
  const series = useAnalyticsSeries();
  const tokens = projects.map((p) => p.token);
  const { data: holders, isLoading: holdersLoading } = useProtocolHolders(tokens);

  // Total ballast = Σ verified treasury value across the same projects listed below.
  let totalBallastUsd = 0n;
  for (const p of projects) if (p.backing) totalBallastUsd += p.backing.totalValueUsd;

  const volumeOk = series.available && series.volume24hUsd !== undefined;
  const holdersOk = holders.available && holders.uniqueHolders !== undefined;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Total ballast"
        value={isLoading ? undefined : formatUsd(totalBallastUsd, { compact: true })}
        sub="Live · on-chain"
        loading={isLoading}
        accent
      />
      <StatCard
        label="Tokens launched"
        value={isLoading ? undefined : String(count)}
        sub="Live · on-chain"
        loading={isLoading}
      />
      <StatCard
        label="24h volume"
        value={volumeOk ? usdCompact(series.volume24hUsd!) : null}
        sub={volumeOk ? freshLabel("GeckoTerminal", series.fetchedAt, now) : "GeckoTerminal · unavailable"}
        loading={Boolean(series.isLoading) && !series.fetchedAt}
      />
      <StatCard
        label="Holders"
        value={holdersOk ? `${holders.exact === false ? "≥" : ""}${holders.uniqueHolders!.toLocaleString("en")}` : null}
        sub={holdersOk ? freshLabel("Blockscout", holders.fetchedAt, now) : "Blockscout · unavailable"}
        loading={holdersLoading && !holders.fetchedAt}
      />
    </div>
  );
}

// value: a string to show, `null` for an unreachable source (em dash + the sub-line
// already says "unavailable"), or `undefined` while its read is still in flight
// (skeleton). A settled value crossfades in by key — it never counts up (hard rule).
function StatCard({
  label,
  value,
  sub,
  loading,
  accent,
}: {
  label: string;
  value: string | null | undefined;
  sub: string;
  loading?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={cn("card p-4", accent && "border-accent")}>
      <div className="eyebrow">{label}</div>
      {loading ? (
        <div className="mt-1.5 h-7 w-20 animate-pulse rounded bg-surface-raised" />
      ) : value === null || value === undefined ? (
        <div className="mt-1 figure-primary text-2xl text-text-muted">—</div>
      ) : (
        <div className="mt-1 figure-primary text-2xl tabular-nums">
          <span key={value} className="anim-fade inline-block">
            {value}
          </span>
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 text-xs text-text-faint">
        {loading ? (
          <span className="inline-block h-3 w-16 animate-pulse rounded bg-surface-raised align-middle" />
        ) : (
          <>
            {/* A quiet live dot when the figure updates on our 12s/30s cadence. */}
            {sub.startsWith("Live") && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green" aria-hidden />}
            <span>{sub}</span>
          </>
        )}
      </div>
    </div>
  );
}

function freshLabel(source: string, fetchedAt: number | undefined, now: number): string {
  if (fetchedAt && now > 0) return `${source} · ${timeAgo(fetchedAt, now)}`;
  return source;
}

// Plain-number USD, compact (indexer values are JS numbers, not 1e18 bigints).
function usdCompact(n: number): string {
  return Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    notation: n >= 1000 ? "compact" : "standard",
    maximumFractionDigits: n >= 1000 ? 1 : 2,
  }).format(n);
}
