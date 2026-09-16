"use client";

import type { Project } from "@/hooks/useProjects";
import { useAnalyticsSeries } from "@/hooks/useAnalyticsSeries";
import { useBuyback } from "@/hooks/useBuyback";
import { useNow } from "@/hooks/useNow";
import { formatUsd, timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";

// The four headline figures above the Discover board (spec §5.2: reserve value
// locked, 24h volume, tokens launched, total burned). Locked and burned are the
// two figures that say what Ballast actually is — a holders-count card doesn't,
// so it isn't here even though it was in an earlier revision.
//
// Reconciliation by construction: locked value and tokens-launched are derived
// from the SAME `projects` array Discover renders below (passed in as a prop, not
// a separate counter), so they can never drift from the list. 24h volume comes
// from GeckoTerminal; total burned from BuybackBurner's own dead-address balance
// (useBuyback — independently verifiable, not the contract's self-reported
// counter). Each card states its source and freshness; an unreachable source
// shows an em dash + "unavailable", never a zero.
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
  const buyback = useBuyback();

  // Locked = Σ the portion of each treasury that can never leave (the figure that
  // actually backs the token), not total treasury value (which includes what a
  // creator could still withdraw).
  let lockedUsd = 0n;
  for (const p of projects) if (p.backing) lockedUsd += p.backing.lockedValueUsd;

  const volumeOk = series.available && series.volume24hUsd !== undefined;
  const burnedOk = buyback.configured && buyback.totalBurned !== undefined;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Reserve value locked"
        value={isLoading ? undefined : formatUsd(lockedUsd, { compact: true })}
        sub="Live · on-chain"
        loading={isLoading}
        accent
      />
      <StatCard
        label="24h volume"
        value={volumeOk ? usdCompact(series.volume24hUsd!) : null}
        sub={volumeOk ? freshLabel("GeckoTerminal", series.fetchedAt, now) : "GeckoTerminal · unavailable"}
        loading={Boolean(series.isLoading) && !series.fetchedAt}
      />
      <StatCard
        label="Tokens launched"
        value={isLoading ? undefined : String(count)}
        sub="Live · on-chain"
        loading={isLoading}
      />
      <StatCard
        label="Total burned"
        value={burnedOk ? formatUsdBurned(buyback.totalBurned!, buyback.totalSupply) : null}
        sub={buyback.configured ? "Live · on-chain (dead-address balance)" : "Not deployed yet"}
        loading={buyback.isLoading}
      />
    </div>
  );
}

// $BALLAST has no USD price feed of its own for burned-supply purposes — show the
// burned share of supply (a real, on-chain-verifiable ratio) rather than inventing
// a USD figure from a market price that can move independently of what's burned.
function formatUsdBurned(totalBurned: bigint, totalSupply: bigint | undefined): string {
  const tokens = Number(totalBurned) / 1e18;
  const tokenLabel = Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
  if (!totalSupply || totalSupply === 0n) return `${tokenLabel} $BALLAST`;
  const pct = (Number(totalBurned) / Number(totalSupply)) * 100;
  return `${tokenLabel} (${pct.toFixed(2)}%)`;
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
