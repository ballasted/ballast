"use client";

import { useProtocolStats } from "@/hooks/useProtocolStats";
import { useAnalyticsSeries, type AnalyticsSeries } from "@/hooks/useAnalyticsSeries";
import { useNow } from "@/hooks/useNow";
import { formatUsd } from "@/lib/format";
import { formatEt } from "@/lib/marketHours";
import { BarChart } from "@/components/app/analytics/BarChart";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

// Analytics (visual-upgrade Phase 4). Two data tiers, each labelled with its
// source and freshness:
//   • Chain-live    — total ballast, ballasted share, all-time launches. Read from
//     the factory registry + BackingLens via the SAME hook Discover uses, so the
//     totals reconcile with Discover by construction.
//   • GeckoTerminal — 24h volume/trades and the daily-volume series. Degrade to
//     "unavailable" with the last fetch time; never a stale or zero value (spec §3.2).
export function AnalyticsView() {
  const now = useNow();
  const stats = useProtocolStats();
  const series = useAnalyticsSeries();

  if (!stats.isConfigured) {
    return (
      <Panel center>
        <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
        <h2 className="font-serif font-semibold text-bone">Not configured yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
          Factory and BackingLens addresses aren&apos;t set. Deploy the core contracts and set
          NEXT_PUBLIC_FACTORY_ADDRESS and NEXT_PUBLIC_LENS_ADDRESS to read the registry live.
        </p>
      </Panel>
    );
  }

  if (!stats.isLoading && !stats.hasLaunches) {
    return (
      <Panel center>
        <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
        <h2 className="font-serif font-semibold text-bone">Nothing to measure yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
          No launches on this network yet — nothing to measure, not zeros. The first launch shows up here and in
          Discover the moment it confirms.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-8">
      {/* Source & freshness banner — like Pons' "Dune updated…", but honest about
          which tier each figure comes from. */}
      <FreshnessBanner series={series} now={now} />

      {/* ── Hero row — three figures, serif, large, with delta vs prior period ── */}
      <section className="grid gap-3 sm:grid-cols-3">
        <HeroFigure
          label="24h volume"
          value={series.available ? usdNum(series.volume24hUsd) : undefined}
          fallback={degradeLabel(series)}
          delta={<Delta cur={series.volume24hUsd} prev={series.volumePrev24hUsd} />}
          source={series.available ? "GeckoTerminal" : undefined}
        />
        <HeroFigure
          label="Launches"
          value={stats.isLoading ? undefined : String(stats.launchesAllTime)}
          fallback="reading chain…"
          sub="all time"
          source="Chain-live"
        />
        <HeroFigure
          label="24h trades"
          value={series.available ? numFmt(series.trades24h) : undefined}
          fallback={degradeLabel(series)}
          sub={series.available ? "across all launches" : undefined}
          source={series.available ? "GeckoTerminal" : undefined}
        />
      </section>

      {/* ── The thesis, expressed as numbers — above the charts. No other
          launchpad on this chain can produce this block. ── */}
      <section>
        <h2 className="field-label mb-3 text-text-faint">What only BALLAST can show</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <ThesisFigure
            label="Total ballast"
            value={stats.isLoading ? undefined : formatUsd(stats.totalBallastUsd, { compact: true })}
            sub={`${formatUsd(stats.lockedBallastUsd, { compact: true })} locked forever`}
            source="Chain-live"
            accent
          />
          <ThesisFigure
            label="Median backing ratio"
            value={stats.medianBackingRatio !== null ? `${stats.medianBackingRatio.toFixed(2)}×` : undefined}
            fallback="no priced ballasted token yet"
            sub="market price ÷ backing"
            source={stats.medianBackingRatio !== null ? "Chain-live" : undefined}
          />
          <ThesisFigure
            label="Ballasted share"
            value={
              stats.ballastedSharePct === undefined ? undefined : `${Math.round(stats.ballastedSharePct)}%`
            }
            fallback="reading chain…"
            sub={`${stats.ballastedCount} of ${stats.launchesAllTime} carry a treasury`}
            source="Chain-live"
            accent
          />
        </div>
      </section>

      <Meander className="opacity-60" />

      {/* ── Daily volume — from GeckoTerminal OHLCV, summed across launch pools.
          Per-day trade counts and per-day launches aren't available without an
          indexer (the trades endpoint is a short window), so we don't chart a
          fabricated series — only real daily volume. ── */}
      <section>
        <ChartCard title="Daily volume" series={series}>
          {series.available && series.daily.length > 0 ? (
            <BarChart
              ariaLabel="Daily traded volume in USD"
              data={series.daily.map((d) => ({ label: d.day, value: d.volumeUsd }))}
              formatValue={(n) => usdNum(n)}
            />
          ) : null}
        </ChartCard>
      </section>
    </div>
  );
}

// ── freshness / source ────────────────────────────────────────────────────────
function FreshnessBanner({ series, now }: { series: AnalyticsSeries; now: number }) {
  const chainLine = "Backing & totals read live from chain";
  const market = series.available
    ? `Volume & trades via GeckoTerminal${series.fetchedAt ? ` · updated ${formatEt(series.fetchedAt)}` : ""}`
    : `Volume & trades ${degradeLabel(series).toLowerCase()}${
        series.fetchedAt ? ` · last fetch ${formatEt(series.fetchedAt)}` : ""
      }`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-faint">
      <span className="inline-flex items-center gap-1 text-green">
        <span aria-hidden>●</span> {chainLine}
      </span>
      <span aria-hidden>·</span>
      <span className={series.available ? "text-text-muted" : "text-warning"}>{market}</span>
      {now > 0 && <span className="ml-auto text-text-faint">as of {formatEt(now)}</span>}
    </div>
  );
}

function degradeLabel(series: AnalyticsSeries): string {
  if (series.available) return "";
  return "GeckoTerminal unreachable";
}

// ── figure tiles ──────────────────────────────────────────────────────────────
function HeroFigure({
  label,
  value,
  fallback,
  sub,
  delta,
  source,
}: {
  label: string;
  value?: string;
  fallback?: string;
  sub?: string;
  delta?: React.ReactNode;
  source?: string;
}) {
  return (
    <div className="card p-5">
      <div className="field-label mb-0 text-text-faint">{label}</div>
      <div className="mt-2 font-serif text-3xl font-semibold tabular-nums text-bone">
        <FigureValue value={value} fallback={fallback} />
      </div>
      <div className="mt-1 min-h-[18px] text-xs">
        {value && delta ? delta : sub ? <span className="text-text-muted">{sub}</span> : null}
      </div>
      {source && <SourceTag source={source} />}
    </div>
  );
}

// A figure while its chain/indexer read is in flight shows a skeleton bar (not a
// blank), then crossfades the settled value in. If the source is unavailable it
// shows the honest fallback label instead — never a fabricated zero.
function FigureValue({ value, fallback }: { value?: string; fallback?: string }) {
  if (value !== undefined) {
    return (
      <span key={value} className="anim-fade inline-block">
        {value}
      </span>
    );
  }
  if (fallback && /…$/.test(fallback)) {
    return <span className="inline-block h-7 w-24 animate-pulse rounded bg-surface-raised align-middle" aria-hidden />;
  }
  return <span className="text-base font-sans font-normal text-text-faint">{fallback}</span>;
}

function ThesisFigure({
  label,
  value,
  fallback,
  sub,
  source,
  accent,
}: {
  label: string;
  value?: string;
  fallback?: string;
  sub?: string;
  source?: string;
  accent?: boolean;
}) {
  return (
    <div className={cn("card p-5", accent && "border-accent")}>
      <div className="field-label mb-0 text-text-faint">{label}</div>
      <div className="mt-2 font-serif text-3xl font-semibold tabular-nums text-bone">
        <FigureValue value={value} fallback={fallback} />
      </div>
      {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
      {source && <SourceTag source={source} />}
    </div>
  );
}

function SourceTag({ source }: { source: string }) {
  const chain = source === "Chain-live";
  return (
    <div className={cn("mt-3 inline-flex items-center gap-1 text-[11px]", chain ? "text-green" : "text-text-faint")}>
      <span aria-hidden>{chain ? "●" : "◴"}</span> {source}
    </div>
  );
}

function Delta({ cur, prev }: { cur?: number; prev?: number }) {
  if (cur === undefined || prev === undefined || prev === 0) {
    return <span className="text-text-faint">no prior period</span>;
  }
  const pct = ((cur - prev) / prev) * 100;
  const up = pct >= 0;
  return (
    <span className={up ? "text-positive" : "text-negative"}>
      {up ? "+" : ""}
      {pct.toFixed(1)}% vs prior 24h
    </span>
  );
}

function ChartCard({
  title,
  series,
  children,
}: {
  title: string;
  series: AnalyticsSeries;
  children: React.ReactNode;
}) {
  const hasData = series.available && series.daily.length > 0;
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <span className="text-[11px] text-text-faint">Last 30 days · GeckoTerminal</span>
      </div>
      <div className="mt-4">
        {hasData ? (
          children
        ) : (
          <div className="flex h-40 flex-col items-center justify-center rounded-input border border-dashed border-border text-center">
            <p className="text-sm text-warning">{series.available ? "No activity in this window yet" : degradeLabel(series)}</p>
            <p className="mt-1 max-w-xs text-xs text-text-faint">
              {series.available
                ? "Bars appear as pools trade — from GeckoTerminal daily OHLCV, never fabricated."
                : "GeckoTerminal didn't respond; the series fills in once it's reachable. Totals above are chain-live."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return <div className={cn("card p-8", center && "text-center")}>{children}</div>;
}

// Plain-number USD (indexer values are JS numbers, not 1e18 bigints).
function usdNum(n?: number): string {
  if (n === undefined) return "—";
  return Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

function numFmt(n?: number): string {
  if (n === undefined) return "—";
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
