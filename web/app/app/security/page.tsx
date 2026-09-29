"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { Address } from "viem";
import { useProjects } from "@/hooks/useProjects";
import { useSecurityChecks } from "@/hooks/useSecurityCheck";
import { formatEt } from "@/lib/marketHours";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { CheckStatus, SecurityCheckResult } from "@/lib/goplus";

// Dashboard: every launch whose live GoPlus scan has anything other than a
// clean row — a fail, an absent/unknown field, or no scan at all. Purely a
// filter over the SAME per-token data the token page's Security checks panel
// shows (one batched request instead of one per card), so this list can never
// disagree with what a visitor sees on an individual token page.
export default function SecurityPage() {
  const { projects, isLoading: projectsLoading, isConfigured } = useProjects();
  const tokens = useMemo(() => projects.map((p) => p.token), [projects]);
  const { data, isLoading } = useSecurityChecks(tokens);

  const flagged: { token: Address; symbol?: string; result: SecurityCheckResult }[] = useMemo(() => {
    if (!data?.available) return [];
    const out: { token: Address; symbol?: string; result: SecurityCheckResult }[] = [];
    for (const p of projects) {
      const result = data.results[p.token.toLowerCase()];
      if (result && (!result.scanned || result.anyFail || result.anyUnknown)) {
        out.push({ token: p.token, symbol: p.symbol, result });
      }
    }
    return out;
  }, [projects, data]);

  const loading = projectsLoading || isLoading;

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <h1 className="section-label">Security</h1>
        <dl className="mt-3 grid grid-cols-2 gap-3">
          <Stat label="Flagged" value={loading || !data?.available ? "—" : String(flagged.length)} />
          <Stat label="Scanned" value={loading ? "—" : String(projects.length)} />
        </dl>
      </section>

      {!isConfigured ? (
        <EmptyState title="Not configured" />
      ) : loading ? (
        <SkeletonList />
      ) : !data?.available ? (
        <EmptyState title="Unknown — check unavailable" />
      ) : flagged.length === 0 ? (
        <EmptyState title="Nothing flagged" />
      ) : (
        <ul className="space-y-2">
          {flagged.map((r) => (
            <FlaggedRow key={r.token} token={r.token} symbol={r.symbol} result={r.result} />
          ))}
        </ul>
      )}

      {data?.fetchedAt && data.available && (
        <p className="text-xs text-text-faint">via GoPlus, checked {formatEt(data.fetchedAt)}</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="figure-primary text-2xl tabular-nums">{value}</dd>
      <dt className="metric-secondary mt-0.5">{label}</dt>
    </div>
  );
}

function FlaggedRow({ token, symbol, result }: { token: Address; symbol?: string; result: SecurityCheckResult }) {
  const chips: { label: string; status: CheckStatus }[] = !result.scanned
    ? [{ label: "Not yet scanned", status: "unknown" }]
    : (
        [
          { label: "Source", status: result.verifiedSource.status },
          { label: "Honeypot", status: result.honeypot.status },
          { label: "Buy tax", status: result.buyTax.status },
          { label: "Sell tax", status: result.sellTax.status },
          { label: "Can buy", status: result.cannotBuy.status },
          { label: "Pausable", status: result.transferPausable.status },
        ] as { label: string; status: CheckStatus }[]
      ).filter((c) => c.status !== "pass");

  return (
    <Link
      href={`/app/token/${token}`}
      className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-text-faint"
    >
      <span className="font-mono text-sm text-text-primary">{symbol ? `$${symbol}` : shortAddress(token)}</span>
      <span className="flex flex-wrap justify-end gap-1.5">
        {chips.map((c) => (
          <span key={c.label} className={cn("chip", c.status === "fail" ? "chip-negative" : "chip-neutral")}>
            {c.label}
          </span>
        ))}
      </span>
    </Link>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="card flex flex-col items-center p-10 text-center">
      <h2 className="font-serif text-lg font-semibold text-bone">{title}</h2>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-card bg-surface-raised" />
      ))}
    </div>
  );
}
