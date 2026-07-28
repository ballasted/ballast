"use client";

import { useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { usePortfolio, type Holding } from "@/hooks/usePortfolio";
import { ConnectButton } from "@/components/app/ConnectButton";
import { FeePanel } from "@/components/app/FeePanel";
import { Meander } from "@/components/Meander";
import { formatUsd, formatBackingPerToken } from "@/lib/format";
import type { Project } from "@/hooks/useProjects";
import { cn } from "@/lib/cn";

export default function PortfolioPage() {
  const [tab, setTab] = useState<"holdings" | "launches">("holdings");
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
    return <Notice title="Not configured yet" body="Deploy the core contracts and set the factory + lens addresses to read your holdings." />;
  }
  if (!isConnected) {
    return (
      <div className="card p-8 text-center">
        <h1 className="font-semibold text-text-primary">Connect your wallet</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">Your holdings, backing exposure, and launches are read live from your wallet.</p>
        <div className="mt-4 flex justify-center"><ConnectButton /></div>
      </div>
    );
  }

  const backedPct = totalValue > 0n ? Number((backedValue * 10000n) / totalValue) / 100 : 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Portfolio</h1>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="figure-primary text-3xl">{formatUsd(totalValue, { compact: true })}</span>
          <span className="metric-secondary">{hasMarketData ? "valued at market where a pool exists, else backing" : "valued at backing"}</span>
        </div>
        {/* P&L needs cost basis, which needs trade history — no honest number without an indexer. */}
        <p className="mt-1 text-xs text-text-faint">P&amp;L needs your entry prices; those come from trade history, which isn&apos;t indexed yet.</p>
      </div>

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
            <div className="figure-primary">{formatUsd(backedValue, { compact: true })}</div>
          </div>
          <div className="text-right">
            <div className="text-text-muted">Unbacked</div>
            <div className="figure-primary">{formatUsd(unbackedValue, { compact: true })}</div>
          </div>
        </div>
      </section>

      {/* Accrued swap fees + Claim. Page-level (not buried under a tab) so it also
          reaches the platform vault and referrers, who have no launches but do
          accrue fees. Self-hides when nothing is owed. */}
      <FeePanel title="Claimable swap fees" />

      <div className="flex gap-6 border-b border-border">
        {(["holdings", "launches"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "relative -mb-px border-b-2 pb-2.5 text-sm capitalize",
              tab === t ? "border-green text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
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
              title="You hold nothing yet"
              body="No BALLAST tokens in this wallet on this network. Once you hold some, the backed-versus-unbacked exposure bar above fills in with your real split."
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
            title="No launches yet"
            body="You haven't launched a project from this wallet. When you do, it appears here with its live treasury value."
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
  const amount = Number(formatUnits(h.balance, 18)).toLocaleString("en", { maximumFractionDigits: 2 });
  const ratio =
    h.marketValueUsd !== undefined && h.backingValueUsd > 0n
      ? Number((h.marketValueUsd * 10n ** 18n) / h.backingValueUsd) / 1e18
      : null;
  return (
    <Link href={`/app/token/${p.token}`} className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-text-faint">
      <div className="min-w-0">
        <div className="font-semibold text-text-primary">{p.symbol ?? "—"}</div>
        <div className="metric-secondary">{amount} tokens</div>
      </div>
      <div className="text-right">
        <div className="figure-primary">{formatUsd(h.displayValueUsd, { compact: true })}</div>
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
  return (
    <Link href={`/app/token/${p.token}`} className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-text-faint">
      <div className="min-w-0">
        <div className="font-semibold text-text-primary">{p.symbol ?? "—"}</div>
        <div className="metric-secondary">{p.name ?? "Unnamed project"}</div>
      </div>
      <div className="text-right">
        {p.ballasted && p.backing ? (
          <>
            <div className="figure-primary">{formatUsd(p.backing.totalValueUsd, { compact: true })}</div>
            <div className="metric-secondary">{formatUsd(p.backing.lockedValueUsd, { compact: true })} locked</div>
          </>
        ) : (
          <div className="text-xs text-text-faint">Unbacked</div>
        )}
      </div>
    </Link>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif text-lg font-semibold text-bone">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
