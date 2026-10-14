"use client";

import { formatEther } from "viem";
import type { Address } from "viem";
import { useFeeRouter, type FeeRouterState } from "@/hooks/useFeeRouter";
import { useNow } from "@/hooks/useNow";
import { formatDuration } from "@/lib/format";
import { formatEt } from "@/lib/marketHours";
import { cn } from "@/lib/cn";

type BucketKey = "creatorBps" | "treasuryBps" | "buybackBps" | "rewardsBps";
const BUCKETS: { key: BucketKey; pendingKey: keyof FeeRouterState; label: string; color: string }[] = [
  { key: "creatorBps", pendingKey: "pendingCreatorBps", label: "Creator", color: "bg-green" },
  { key: "treasuryBps", pendingKey: "pendingTreasuryBps", label: "Treasury", color: "bg-bone/30" },
  { key: "buybackBps", pendingKey: "pendingBuybackBps", label: "Buyback & burn", color: "bg-warning" },
  { key: "rewardsBps", pendingKey: "pendingRewardsBps", label: "Stakers", color: "bg-accent" },
];

function fmtWeth(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const n = Number(formatEther(v));
  return `${n < 0.0001 && n > 0 ? "<0.0001" : n.toFixed(4)} WETH`;
}

/**
 * "Where fees go" — renders nothing if this token has no FeeRouter (the normal
 * case today). Shows the split that's ACTIVE now and, if a change is scheduled,
 * the SCHEDULED split with the exact time it takes effect (the on-chain 7-day
 * delay). The treasury bucket is hidden while it's unsupported in the UI (always
 * 0) rather than shown as a dead 0%. Labels and numbers only (UI principles).
 */
export function FeeRouterCard({ token }: { token?: Address }) {
  const { state, isLoading } = useFeeRouter(token);
  const now = useNow();
  if (isLoading || !state) return null;

  // Hide the treasury bucket unless it's actually used (active or scheduled) —
  // it's not wireable from the UI yet, so a 0% row would just be noise.
  const treasuryUsed = state.treasuryBps > 0 || (state.hasPendingSplit && state.pendingTreasuryBps > 0);
  const buckets = BUCKETS.filter((b) => b.key !== "treasuryBps" || treasuryUsed);

  const effectiveAt = Number(state.pendingEffectiveAt);
  const secsLeft = Math.max(0, effectiveAt - (now > 0 ? now : Math.floor(Date.now() / 1000)));

  return (
    <section className="card space-y-4 p-5">
      <h2 className="section-label">Where fees go</h2>

      {/* Active now */}
      <div>
        <div className="eyebrow mb-2">Active now</div>
        <SplitBar buckets={buckets} value={(b) => state[b.key]} />
        <SplitLegend buckets={buckets} value={(b) => state[b.key]} />
      </div>

      {/* Scheduled (pending) */}
      {state.hasPendingSplit && (
        <div className="rounded-input border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">Scheduled</span>
            <span className="text-xs text-text-faint">
              {secsLeft > 0 ? `in ${formatDuration(secsLeft)} · ${formatEt(effectiveAt)}` : `applies on next route · ${formatEt(effectiveAt)}`}
            </span>
          </div>
          <div className="mt-2 opacity-60">
            <SplitBar buckets={buckets} value={(b) => Number(state[b.pendingKey] as number)} />
            <SplitLegend buckets={buckets} value={(b) => Number(state[b.pendingKey] as number)} />
          </div>
        </div>
      )}

      <div className={cn("grid gap-3 border-t border-border pt-3 text-center", treasuryUsed ? "grid-cols-3" : "grid-cols-2")}>
        {treasuryUsed && <Stat label="Added to treasury" value={fmtWeth(state.totalRoutedToTreasury)} />}
        <Stat label="Tokens burned" value={state.totalTokenBurned > 0n ? formatEther(state.totalTokenBurned) : "0"} />
        <Stat label="Rewards paid" value={fmtWeth(state.totalRoutedToRewards)} />
      </div>
    </section>
  );
}

function SplitBar({ buckets, value }: { buckets: typeof BUCKETS; value: (b: (typeof BUCKETS)[number]) => number }) {
  const total = buckets.reduce((s, b) => s + value(b), 0) || 1;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised">
      {buckets.map((b) => {
        const pct = (value(b) / total) * 100;
        if (pct <= 0) return null;
        return <div key={b.key} className={cn(b.color, "h-full")} style={{ width: `${pct}%` }} />;
      })}
    </div>
  );
}

function SplitLegend({ buckets, value }: { buckets: typeof BUCKETS; value: (b: (typeof BUCKETS)[number]) => number }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
      {buckets.map((b) => (
        <div key={b.key} className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", b.color)} />
          <span className="text-text-secondary">{b.label}</span>
          <span className="ml-auto font-mono text-text-primary">{(value(b) / 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
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
