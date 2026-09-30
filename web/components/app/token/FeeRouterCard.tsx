"use client";

import { formatEther } from "viem";
import type { Address } from "viem";
import { useFeeRouter } from "@/hooks/useFeeRouter";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/cn";

const BUCKETS = [
  { key: "creatorBps", label: "Creator", color: "bg-green" },
  { key: "treasuryBps", label: "Treasury", color: "bg-bone/30" },
  { key: "buybackBps", label: "Buyback & burn", color: "bg-warning" },
  { key: "rewardsBps", label: "Stakers", color: "bg-accent" },
] as const;

function fmtWeth(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const n = Number(formatEther(v));
  return `${n < 0.0001 && n > 0 ? "<0.0001" : n.toFixed(4)} WETH`;
}

/**
 * "Where fees go" — renders nothing if this token has no FeeRouter (the normal
 * case today). Labels and numbers only, no prose (CLAUDE.md UI principles).
 */
export function FeeRouterCard({ token }: { token?: Address }) {
  const { state, isLoading } = useFeeRouter(token);
  if (isLoading || !state) return null;

  const total = state.creatorBps + state.treasuryBps + state.buybackBps + state.rewardsBps || 1;
  const daysLeft = state.hasPendingSplit
    ? Math.max(0, Number(state.pendingEffectiveAt) - Math.floor(Date.now() / 1000))
    : 0;

  return (
    <section className="card space-y-4 p-5">
      <h2 className="section-label">Where fees go</h2>

      <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised">
        {BUCKETS.map((b) => {
          const pct = (state[b.key] / total) * 100;
          if (pct <= 0) return null;
          return <div key={b.key} className={cn(b.color, "h-full")} style={{ width: `${pct}%` }} />;
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {BUCKETS.map((b) => (
          <div key={b.key} className="flex items-center gap-1.5">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", b.color)} />
            <span className="text-text-secondary">{b.label}</span>
            <span className="ml-auto font-mono text-text-primary">{(state[b.key] / 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3 border-t border-border pt-3 text-center">
        <Stat label="Added to treasury" value={fmtWeth(state.totalRoutedToTreasury)} />
        <Stat label="Tokens burned" value={state.totalTokenBurned > 0n ? formatEther(state.totalTokenBurned) : "0"} />
        <Stat label="Rewards paid" value={fmtWeth(state.totalRoutedToRewards)} />
      </div>

      {state.hasPendingSplit && (
        <p className="rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
          New split applies in {formatDuration(daysLeft)}.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-text-faint">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-text-primary">{value}</div>
    </div>
  );
}
