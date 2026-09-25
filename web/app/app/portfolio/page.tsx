"use client";

import { useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { usePortfolio, type Holding } from "@/hooks/usePortfolio";
import { WalletGate } from "@/components/app/WalletGate";
import { FeePanel } from "@/components/app/FeePanel";
import { BackedByChip, PoolChips } from "@/components/app/LaunchChips";
import { useAssets } from "@/hooks/useAssets";
import { Meander } from "@/components/Meander";
import { CopyAddress } from "@/components/app/CopyAddress";
import { formatUsd, formatBackingPerToken, shortAddress } from "@/lib/format";
import type { Project } from "@/hooks/useProjects";
import { cn } from "@/lib/cn";

export default function PortfolioPage() {
  const [tab, setTab] = useState<"holdings" | "launches">("holdings");
  const { address: account } = useAccount();
  const {
    isConnected,
    isConfigured,
    isLoading,
    holdings,
    myLaunches,
    totalValue,
    backedValue,
    unbackedValue,
    hasMarketData,
  } = usePortfolio();

  if (!isConfigured) {
    return <Notice title="Not configured yet" body="Set the factory + lens addresses (after deploy) to read your holdings." />;
  }
  if (!isConnected || !account) {
    return <WalletGate body="Holdings, exposure, and launches read live from your wallet." />;
  }

  const backedPct = totalValue > 0n ? Number((backedValue * 10000n) / totalValue) / 100 : 0;

  return (
    <div className="space-y-5">
      <section className="card flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-bg font-semibold text-green ring-1 ring-inset ring-bone/10">
            {account.slice(2, 4).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-serif text-lg font-semibold text-bone">Portfolio</h1>
              <span className="chip chip-accent">Connected</span>
            </div>
            <CopyAddress address={account} label={shortAddress(account)} />
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="eyebrow">Portfolio value</div>
          <div className="mt-0.5 flex items-baseline gap-2 sm:justify-end">
            <span data-balance className="figure-primary text-4xl">
              {formatUsd(totalValue, { compact: true })}
            </span>
          </div>
          <div className="metric-secondary">
            {hasMarketData ? "valued at market where a pool exists, else backing" : "valued at backing"}
          </div>
        </div>
      </section>

      {/* P&L is deliberately absent — see the tooltip. Holdings/value are exact
          chain reads; cost basis can't be reconstructed from public data
          without guessing, and a wrong P&L is worse than none. */}
      <span
        className="chip chip-neutral"
        title="No P&L: reconstructing what you paid needs your full buy history at execution prices, which can't be derived from public data without guessing"
      >
        No P&amp;L shown
      </span>

      {/* Headline counts — same numbers the exposure card and tabs below are
          built from, just surfaced at a glance (no new data source). */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Holdings" value={String(holdings.length)} />
        <Stat label="Launches" value={String(myLaunches.length)} />
        <Stat label="Backed" value={`${backedPct.toFixed(0)}%`} />
        <Stat label="Backed value" value={formatUsd(backedValue, { compact: true })} balance />
      </section>

      {/* Backed vs unbacked exposure (spec §9). */}
      <section className="card p-4">
        <div className="text-sm font-semibold text-text-primary">Backing exposure</div>
        <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-border">
          <div className="bar-grow bg-green" style={{ width: `${backedPct}%` }} />
          <div className="bg-text-faint" style={{ width: `${100 - backedPct}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-green">Ballasted</div>
            <div data-balance className="figure-primary">{formatUsd(backedValue, { compact: true })}</div>
          </div>
          <div className="text-right">
            <div className="text-text-muted">Unbacked</div>
            <div data-balance className="figure-primary">{formatUsd(unbackedValue, { compact: true })}</div>
          </div>
        </div>
      </section>

      {/* Accrued swap fees + Claim. Page-level (not buried under a tab) so it also
          reaches the platform vault and referrers, who have no launches but do
          accrue fees. Self-hides when nothing is owed. */}
      <FeePanel title="Claimable swap fees" />

      <div className="flex gap-2">
        {(["holdings", "launches"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn("tab", tab === t ? "tab-active" : "tab-idle")}>
            {t === "holdings" ? "Holdings" : "My launches"}
          </button>
        ))}
      </div>

      <div key={tab} className="anim-fade">
        {isLoading ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 animate-pulse rounded-full bg-surface-raised" />
                  <div className="space-y-1.5">
                    <div className="h-4 w-20 animate-pulse rounded bg-surface-raised" />
                    <div className="h-3 w-28 animate-pulse rounded bg-surface-raised" />
                  </div>
                </div>
                <div className="h-5 w-16 animate-pulse rounded bg-surface-raised" />
              </div>
            ))}
          </div>
        ) : tab === "holdings" ? (
          holdings.length === 0 ? (
            <Notice
              title="Nothing yet."
              action={
                <Link href="/app/discover" className="btn-primary inline-block px-5">
                  Find a project on Discover
                </Link>
              }
            />
          ) : (
            <div className="space-y-2">
              {holdings.map((h) => <HoldingRow key={h.project.token} h={h} />)}
            </div>
          )
        ) : myLaunches.length === 0 ? (
          <Notice
            title="Nothing yet."
            action={
              <Link href="/app/create" className="btn-primary inline-block px-5">
                Create a launch
              </Link>
            }
          />
        ) : (
          <div className="space-y-2">{myLaunches.map((p) => <LaunchRow key={p.token} p={p} />)}</div>
        )}
      </div>
    </div>
  );
}

function HoldingRow({ h }: { h: Holding }) {
  const { project: p } = h;
  const { assets: registry, isLoading: registryLoading } = useAssets();
  const backingAsset = (p.backing?.assets as unknown as { asset: `0x${string}` }[] | undefined)?.[0];
  const amount = Number(formatUnits(h.balance, 18)).toLocaleString("en", { maximumFractionDigits: 2 });
  const ratio =
    h.marketValueUsd !== undefined && h.backingValueUsd > 0n
      ? Number((h.marketValueUsd * 10n ** 18n) / h.backingValueUsd) / 1e18
      : null;
  return (
    <Link href={`/app/token/${p.token}`} className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-text-faint">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-text-primary">{p.symbol ?? "—"}</span>
          <BackedByChip backingAsset={backingAsset?.asset} registry={registry} registryLoaded={!registryLoading} compact />
          <PoolChips quoteAssets={p.quoteAssets} registry={registry} registryLoaded={!registryLoading} compact />
        </div>
        <div className="metric-secondary">{amount} tokens</div>
      </div>
      <div className="text-right">
        <div data-balance className="figure-primary">{formatUsd(h.displayValueUsd, { compact: true })}</div>
        {p.ballasted ? (
          <div className="metric-secondary">
            Backing {formatBackingPerToken(p.backing!.backingPerToken)}{ratio !== null ? ` · ${ratio.toFixed(2)}×` : ""}
          </div>
        ) : (
          <div className="text-xs text-text-faint">Unbacked</div>
        )}
      </div>
    </Link>
  );
}

function LaunchRow({ p }: { p: Project }) {
  const { assets: registry, isLoading: registryLoading } = useAssets();
  const backingAsset = (p.backing?.assets as unknown as { asset: `0x${string}` }[] | undefined)?.[0];
  return (
    <Link href={`/app/token/${p.token}`} className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-text-faint">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-text-primary">{p.symbol ?? "—"}</span>
          <BackedByChip backingAsset={backingAsset?.asset} registry={registry} registryLoaded={!registryLoading} compact />
          <PoolChips quoteAssets={p.quoteAssets} registry={registry} registryLoaded={!registryLoading} compact />
        </div>
        <div className="metric-secondary">{p.name ?? "Unnamed project"}</div>
      </div>
      <div className="text-right">
        {p.ballasted && p.backing ? (
          <>
            <div data-balance className="figure-primary">{formatUsd(p.backing.totalValueUsd, { compact: true })}</div>
            <div data-balance className="metric-secondary">{formatUsd(p.backing.lockedValueUsd, { compact: true })} locked</div>
          </>
        ) : (
          <div className="text-xs text-text-faint">Unbacked</div>
        )}
      </div>
    </Link>
  );
}

function Stat({ label, value, balance }: { label: string; value: string; balance?: boolean }) {
  return (
    <div className="card p-4 text-center">
      <div data-balance={balance ? true : undefined} className="figure-primary text-xl">
        {value}
      </div>
      <div className="metric-secondary">{label}</div>
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif text-lg font-semibold text-bone">{title}</h2>
      {body && <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
