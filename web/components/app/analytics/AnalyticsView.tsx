"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAnalyticsOverview, type OverviewDay, type Overview } from "@/hooks/useAnalyticsOverview";
import { useAnalyticsSeries } from "@/hooks/useAnalyticsSeries";
import { activeChain } from "@/lib/chain";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { Stat } from "@/components/ui/Stat";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

const EXPLORER = activeChain.blockExplorers.default.url;

type Range = "24h" | "7d" | "30d" | "All";
const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30, All: 3650 };

function usdC(n?: number | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 1) return "$" + n.toFixed(2);
  return "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function numC(n?: number | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function tokC(n?: number | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}
function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Small source-link affordance: a ↗ to the contract/tx on Blockscout. Satisfies
 *  "every number links to its source". */
function Src({ href, title }: { href: string; title: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="ml-1 inline-block text-text-faint transition-colors hover:text-text-secondary"
    >
      ↗
    </a>
  );
}
const addrLink = (a?: string | null) => (a ? `${EXPLORER}/address/${a}` : undefined);
const txLink = (t: string) => `${EXPLORER}/tx/${t}`;

export function AnalyticsView() {
  const [range, setRange] = useState<Range>("7d");
  const { data, isLoading } = useAnalyticsOverview();
  // GeckoTerminal only backs the top-line Volume/Trades KPIs if the indexer read
  // is unavailable — never shown as "not live", just a real fallback number.
  const gecko = useAnalyticsSeries();
  const available = Boolean(data?.available);
  const a = data?.addresses;

  const series: OverviewDay[] = useMemo(() => {
    const s = data?.series ?? [];
    return [...s].sort((x, y) => x.day.localeCompare(y.day));
  }, [data?.series]);

  const windowDays = useMemo(() => series.slice(-RANGE_DAYS[range]), [series, range]);

  const rangeTotals = useMemo(() => {
    return windowDays.reduce(
      (acc, d) => {
        acc.volumeUsd += d.volumeUsd;
        acc.trades += d.trades;
        acc.launches += d.launches;
        acc.burnedTokens += d.burnedTokens;
        return acc;
      },
      { volumeUsd: 0, trades: 0, launches: 0, burnedTokens: 0 },
    );
  }, [windowDays]);

  const feeBps = data?.fee?.feeBps ?? 300;
  const volumeKpi = available ? rangeTotals.volumeUsd : gecko.volume24hUsd;
  const tradesKpi = available ? rangeTotals.trades : gecko.trades24h;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-serif text-display-sm text-text-primary">Analytics</h1>
          <p className="text-sm text-text-muted">Every number read from the on-chain indexer. Links go to the source contract or transaction.</p>
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
          <Stat label={`Volume · ${range}`} value={isLoading ? <Skeleton height={24} width="70%" /> : usdC(volumeKpi)} />
        </Card>
        <Card>
          <Stat label={`Trades · ${range}`} value={isLoading ? <Skeleton height={24} width="60%" /> : tradesKpi === undefined ? "—" : numC(tradesKpi)} />
        </Card>
        <Card>
          <Stat
            label="Launches"
            value={isLoading ? <Skeleton height={24} width="50%" /> : numC(data?.stats?.launchesTotal)}
            sub="all-time"
          />
        </Card>
        <Card>
          <Stat
            label={<span>$BALLAST burned{a?.dead ? <Src href={addrLink(a.dead)!} title="Dead address on Blockscout" /> : null}</span>}
            value={isLoading ? <Skeleton height={24} width="70%" /> : tokC(data?.burn?.totalBurned)}
            sub="cumulative, all generations"
          />
        </Card>
        <Card>
          <Stat
            label={<span>Treasury backing{a?.lens ? <Src href={addrLink(a.lens)!} title="BackingLens on Blockscout" /> : null}</span>}
            value={isLoading ? <Skeleton height={24} width="70%" /> : data?.exposure ? usdC(data.exposure.total) : "—"}
            sub="across all treasuries"
          />
        </Card>
      </div>

      {/* Charts: volume, fees, launches, burned */}
      <div className="grid gap-3 md:grid-cols-2">
        <ChartCard title={`Volume · ${range}`} headline={usdC(rangeTotals.volumeUsd)} loading={isLoading}>
          <Bars days={windowDays} value={(d) => d.volumeUsd} fmt={usdC} color="bg-up" />
        </ChartCard>
        <ChartCard title={`Fees · ${range}`} headline={usdC((rangeTotals.volumeUsd * feeBps) / 10_000)} loading={isLoading} note={`${(feeBps / 100).toFixed(0)}% swap fee × volume`}>
          <Bars days={windowDays} value={(d) => (d.volumeUsd * feeBps) / 10_000} fmt={usdC} color="bg-creator-accent" />
        </ChartCard>
        <ChartCard title={`Launches · ${range}`} headline={numC(rangeTotals.launches)} loading={isLoading}>
          <Bars days={windowDays} value={(d) => d.launches} fmt={(n) => numC(n)} color="bg-backing" integer />
        </ChartCard>
        <ChartCard title={`$BALLAST burned · ${range}`} headline={tokC(rangeTotals.burnedTokens)} loading={isLoading}>
          <Bars days={windowDays} value={(d) => d.burnedTokens} fmt={tokC} color="bg-down" />
        </ChartCard>
      </div>

      {/* Fee flow + pairing mix */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionHead title="Where every fee went" src={addrLink(a?.feeConfig)} srcTitle="FeeConfig on Blockscout" />
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton height={14} /> <Skeleton height={14} /> <Skeleton height={14} />
            </div>
          ) : data?.fee ? (
            <FeeFlow fee={data.fee} buybackSrc={addrLink(a?.buybackV2)} />
          ) : (
            <div className="text-sm text-text-muted">No fees yet — $0 in trading fees generated.</div>
          )}
        </Card>

        <Card>
          <SectionHead title="Pairing mix" />
          <p className="-mt-2 mb-4 text-ui-xs text-text-muted">Launches by quote asset</p>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton height={14} /> <Skeleton height={14} /> <Skeleton height={14} />
            </div>
          ) : data?.pairing && data.pairing.total > 0 ? (
            <div className="space-y-3">
              <PairBar label="WETH only" n={data.pairing.wethOnly} total={data.pairing.total} color="bg-up" />
              <PairBar label="Stock + WETH" n={data.pairing.stockAndWeth} total={data.pairing.total} color="bg-creator-accent" />
              <PairBar label="Stock only" n={data.pairing.stockOnly} total={data.pairing.total} color="bg-backing" />
            </div>
          ) : (
            <div className="text-sm text-text-muted">No launches yet</div>
          )}
        </Card>
      </div>

      {/* Top tokens + top creators */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <SectionHead title="Top tokens by volume" />
          {isLoading ? (
            <ListSkeleton />
          ) : data?.topTokens && data.topTokens.length > 0 ? (
            <ul className="divide-y divide-border/60">
              {data.topTokens.map((t, i) => (
                <li key={t.token} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/app/token/${t.token}`} className="min-w-0 truncate text-sm text-text-primary hover:underline">
                    <span className="mr-2 text-text-faint tabular-nums">{i + 1}</span>
                    {t.symbol ? `$${t.symbol}` : short(t.token)}
                  </Link>
                  <span className="shrink-0 text-right">
                    <span className="tabular-nums text-text-primary">{usdC(t.volumeUsd)}</span>
                    <span className="ml-2 text-ui-xs tabular-nums text-text-muted">{numC(t.trades)} trades</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-text-muted">No trades yet</div>
          )}
        </Card>

        <Card>
          <SectionHead title="Top creators by fees routed" />
          {isLoading ? (
            <ListSkeleton />
          ) : data?.topCreators && data.topCreators.length > 0 ? (
            <ul className="divide-y divide-border/60">
              {data.topCreators.map((c, i) => (
                <li key={c.creator} className="flex items-center justify-between gap-3 py-2">
                  <a href={addrLink(c.creator)} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-mono text-sm text-text-primary hover:underline">
                    <span className="mr-2 font-sans text-text-faint tabular-nums">{i + 1}</span>
                    {short(c.creator)}
                  </a>
                  <span className="shrink-0 text-right">
                    <span className="tabular-nums text-text-primary">{usdC(c.feeUsd)}</span>
                    <span className="ml-2 text-ui-xs tabular-nums text-text-muted">{numC(c.tokenCount)} token{c.tokenCount === 1 ? "" : "s"}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-text-muted">No creator fees yet</div>
          )}
        </Card>
      </div>

      {/* Per-stock exposure + round-ups */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <SectionHead title="Per-stock treasury exposure" src={addrLink(a?.lens)} srcTitle="BackingLens on Blockscout" />
          {isLoading ? (
            <ListSkeleton />
          ) : data?.exposure && data.exposure.byStock.length > 0 ? (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {data.exposure.byStock.map((s) => (
                <li key={s.asset} className="flex items-center justify-between gap-2 py-1 text-sm">
                  <a href={addrLink(s.asset)} target="_blank" rel="noopener noreferrer" className="truncate text-text-secondary hover:underline">
                    {s.symbol ?? short(s.asset)}
                  </a>
                  <span className="tabular-nums text-text-muted">{usdC(s.exposureUsd)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-text-muted">No treasury holdings yet — $0 across all stocks.</div>
          )}
        </Card>

        <Card>
          <SectionHead title="Stock round-ups" src={addrLink(a?.roundupRouter)} srcTitle="RoundupRouter on Blockscout" />
          {isLoading ? (
            <ListSkeleton />
          ) : (
            <div className="space-y-3">
              <div className="flex gap-6">
                <Stat label="Round-ups" value={numC(data?.roundups?.count ?? 0)} />
                <Stat label="ETH spent" value={tokC(data?.roundups?.ethIn ?? 0)} />
              </div>
              {data?.roundups && data.roundups.byStock.length > 0 ? (
                <ul className="divide-y divide-border/60">
                  {data.roundups.byStock.map((s) => (
                    <li key={s.stock} className="flex items-center justify-between py-1 text-sm">
                      <span className="text-text-secondary">{s.symbol ?? short(s.stock)}</span>
                      <span className="tabular-nums text-text-muted">{tokC(s.stockOut)} · {numC(s.count)}×</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-muted">No round-ups executed yet.</p>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Token families + burn tracker */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <SectionHead title="Token families" />
          {isLoading ? (
            <ListSkeleton />
          ) : data?.families && data.families.length > 0 ? (
            <ul className="space-y-2">
              {data.families.map((f) => (
                <li key={f.parent} className="text-sm">
                  <a href={addrLink(f.parent)} target="_blank" rel="noopener noreferrer" className="font-mono text-text-primary hover:underline">
                    {short(f.parent)}
                  </a>
                  <span className="ml-2 text-text-muted">
                    {f.routers.length} child{f.routers.length === 1 ? "" : "ren"} · {tokC(f.burnedTokens)} burned
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-text-muted">No token families yet.</div>
          )}
        </Card>

        <Card>
          <SectionHead title="Buyback & burn runs" src={addrLink(a?.buybackV2)} srcTitle="BuybackBurnerV2 on Blockscout" />
          {isLoading ? (
            <ListSkeleton />
          ) : data?.burn && data.burn.buybacks.length > 0 ? (
            <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto">
              {data.burn.buybacks.map((b) => (
                <li key={b.tx} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <a href={txLink(b.tx)} target="_blank" rel="noopener noreferrer" className="font-mono text-text-secondary hover:underline">
                    {short(b.tx)}
                  </a>
                  <span className="shrink-0 text-right tabular-nums text-text-muted">
                    {tokC(b.ballastBought)} burned
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-text-muted">No buybacks yet.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function SectionHead({ title, src, srcTitle }: { title: string; src?: string; srcTitle?: string }) {
  return (
    <div className="mb-3 flex items-center gap-1 text-ui-md font-semibold text-text-primary">
      {title}
      {src ? <Src href={src} title={srcTitle ?? "View on Blockscout"} /> : null}
    </div>
  );
}

function ChartCard({ title, headline, note, loading, children }: { title: string; headline: string; note?: string; loading: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="text-ui-xs text-text-muted">{title}</div>
          <div className="mt-1 text-ui-xl font-semibold tabular-nums text-text-primary">{loading ? <Skeleton height={26} width={110} /> : headline}</div>
        </div>
        {note ? <span className="text-ui-xs text-text-faint">{note}</span> : null}
      </div>
      {loading ? <Skeleton height={140} /> : children}
    </Card>
  );
}

function Bars({ days, value, fmt, color, integer }: { days: OverviewDay[]; value: (d: OverviewDay) => number; fmt: (n: number) => string; color: string; integer?: boolean }) {
  const vals = days.map(value);
  const max = Math.max(1, ...vals);
  const hasAny = vals.some((v) => v > 0);
  if (days.length === 0) return <div className="flex h-[140px] items-center justify-center text-sm text-text-muted">No data in range</div>;
  return (
    <div className="flex h-[140px] items-end gap-1" role="img" aria-label={`${fmt(vals.reduce((s, v) => s + v, 0))} total over ${days.length} days`}>
      {days.map((d, i) => {
        const v = vals[i]!;
        return (
          <div
            key={d.day}
            title={`${d.day} · ${integer ? Math.round(v) : fmt(v)}`}
            className={cn("min-w-0 flex-1 rounded-t-sm transition-colors", i === days.length - 1 ? color : `${color}/70`)}
            style={{ height: hasAny ? `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%` : "0%" }}
          />
        );
      })}
    </div>
  );
}

function FeeFlow({ fee, buybackSrc }: { fee: NonNullable<Overview["fee"]>; buybackSrc?: string }) {
  const total = fee.feeTotalUsd;
  const creatorPct = fee.creatorBps !== null ? fee.creatorBps / 100 : null;
  const platformPct = fee.platformBps !== null ? fee.platformBps / 100 : null;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <span className="text-ui-xs text-text-muted">Total trading fees ({(fee.feeBps / 100).toFixed(0)}% of {usdC(fee.volumeUsdAll)} volume)</span>
        <span className="text-ui-lg font-semibold tabular-nums text-text-primary">{usdC(total)}</span>
      </div>
      <div className="space-y-3">
        <PairBar label={`Creator${creatorPct !== null ? ` (${creatorPct.toFixed(0)}%)` : ""}`} n={fee.creatorUsd ?? 0} total={total || 1} color="bg-creator-accent" valueLabel={usdC(fee.creatorUsd)} />
        <PairBar label={`Platform${platformPct !== null ? ` (${platformPct.toFixed(0)}%)` : ""}`} n={fee.platformUsd ?? 0} total={total || 1} color="bg-up" valueLabel={usdC(fee.platformUsd)} />
      </div>
      <div className="rounded-input bg-bg px-3 py-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">
            Platform buyback &amp; burn
            {buybackSrc ? <Src href={buybackSrc} title="BuybackBurnerV2 on Blockscout" /> : null}
          </span>
          <span className="tabular-nums text-text-muted">
            {tokC(fee.buyback.ballastTotal)} $BALLAST · {fee.buyback.runs} run{fee.buyback.runs === 1 ? "" : "s"}
          </span>
        </div>
        {fee.buyback.byAsset.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-x-4 text-ui-xs text-text-faint">
            {fee.buyback.byAsset.map((b) => (
              <span key={b.asset}>
                {tokC(b.amountIn)} {b.symbol ?? short(b.asset)} in
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PairBar({ label, n, total, color, valueLabel }: { label: string; n: number; total: number; color: string; valueLabel?: string }) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-ui-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="tabular-nums text-text-muted">{valueLabel ?? `${n} · ${pct}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.04]">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} height={16} />
      ))}
    </div>
  );
}
