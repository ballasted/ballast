"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useProjects, type Project } from "@/hooks/useProjects";
import { MotionSection } from "@/components/app/MotionSection";
import { formatUsd, formatBackingPerToken, shortAddress } from "@/lib/format";
import { isHiddenToken } from "@/lib/contracts";
import { cn } from "@/lib/cn";

// Public treasuries overview — the aggregate dashboard that complements the
// /app/backing directory (which is the full, searchable list). Reads only
// on-chain state (factory launches + BackingLens), never the wallet, so a
// visitor with no wallet sees everything. The no-claim disclaimer is kept
// verbatim per the project copy rules.
export default function TreasuryPage() {
  const { projects, isLoading, isConfigured, error } = useProjects();

  const treasuries = useMemo(
    () => projects.filter((p) => p.hasTreasury && !isHiddenToken(p.token)),
    [projects],
  );
  const ballasted = useMemo(() => treasuries.filter((p) => p.ballasted), [treasuries]);

  const totalVerified = useMemo(
    () => treasuries.reduce((acc, p) => acc + (p.backing?.totalValueUsd ?? 0n), 0n),
    [treasuries],
  );
  const totalLocked = useMemo(
    () => treasuries.reduce((acc, p) => acc + (p.backing?.lockedValueUsd ?? 0n), 0n),
    [treasuries],
  );

  const topLocked = useMemo(
    () =>
      [...ballasted]
        .sort((a, b) => {
          const d = (b.backing?.lockedValueUsd ?? 0n) - (a.backing?.lockedValueUsd ?? 0n);
          return d > 0n ? 1 : d < 0n ? -1 : 0;
        })
        .slice(0, 6),
    [ballasted],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Treasuries</h1>
          <p className="mt-1 max-w-xl text-sm text-text-muted">
            Every launch holds an on-chain treasury of tokenized real-world assets, valued live.{" "}
            <Link href="/docs" className="underline underline-offset-2 hover:text-text-secondary">
              Docs
            </Link>
          </p>
        </div>
        <Link href="/app/backing" className="btn-secondary shrink-0">
          Browse all
        </Link>
      </div>

      {!isConfigured ? (
        <div className="card p-6 text-center text-sm text-text-muted">Backing lens isn&apos;t configured on this deployment.</div>
      ) : error ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">Couldn&apos;t load treasuries.</p>
          <button className="btn-secondary mt-4" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <MotionSection>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Verified backing" value={formatUsd(totalVerified, { compact: true })} loading={isLoading} />
              <Stat label="Locked forever" value={formatUsd(totalLocked, { compact: true })} accent loading={isLoading} />
              <Stat label="Treasuries" value={String(treasuries.length)} loading={isLoading} />
              <Stat label="With backing" value={String(ballasted.length)} loading={isLoading} />
            </div>
          </MotionSection>

          {!isLoading && topLocked.length > 0 && (
            <MotionSection>
              <section className="card p-4">
                <h2 className="section-label">Most locked forever</h2>
                <div className="mt-3 divide-y divide-border">
                  {topLocked.map((p) => (
                    <TreasuryRow key={p.token} project={p} />
                  ))}
                </div>
              </section>
            </MotionSection>
          )}

          {/* Required disclaimer — kept verbatim (project copy rules). */}
          <p className="rounded-input bg-card px-3 py-2 text-xs text-text-muted">
            Holding a token gives no claim, redemption right, or entitlement to treasury assets.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent, loading }: { label: string; value: string; accent?: boolean; loading?: boolean }) {
  return (
    <div className="card p-4">
      <div className="eyebrow">{label}</div>
      {loading ? (
        <div className="mt-2 h-6 w-20 animate-pulse rounded bg-surface-raised" />
      ) : (
        <div className={cn("figure-primary mt-1 text-xl tabular-nums", accent && "text-green")}>{value}</div>
      )}
    </div>
  );
}

function TreasuryRow({ project }: { project: Project }) {
  const { symbol, token, backing } = project;
  return (
    <Link href={`/app/backing/${token}`} className="flex items-center justify-between py-2.5 text-sm transition-colors hover:text-text-primary">
      <span className="truncate font-medium text-text-secondary">{symbol ?? shortAddress(token)}</span>
      <span className="flex items-center gap-4 tabular-nums">
        <span className="text-text-faint">{formatBackingPerToken(backing?.backingPerToken ?? 0n)}</span>
        <span className="text-green">{formatUsd(backing?.lockedValueUsd ?? 0n, { compact: true })}</span>
      </span>
    </Link>
  );
}
