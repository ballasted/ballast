"use client";

import { useMemo } from "react";
import { formatEther } from "viem";
import type { Address } from "viem";
import { useFeeRouter } from "@/hooks/useFeeRouter";
import { useFeeSplit } from "@/hooks/useFeeSplit";
import { useTokenFamily } from "@/hooks/useTokenFamily";
import { useProjects } from "@/hooks/useProjects";
import { useNow } from "@/hooks/useNow";
import { formatDuration, shortAddress } from "@/lib/format";
import { formatEt } from "@/lib/marketHours";
import { effectiveSplitParts, type RouterSplitBps } from "@/lib/feeRouter";
import { cn } from "@/lib/cn";

function fmtWeth(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const n = Number(formatEther(v));
  return `${n < 0.0001 && n > 0 ? "<0.0001" : n.toFixed(4)} WETH`;
}

function fmtTokens(v: bigint): string {
  if (v <= 0n) return "0";
  const n = Number(formatEther(v));
  if (n < 0.0001) return "<0.0001";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(n < 1 ? 4 : 2);
}

type SplitPart = { key: string; label: string; color: string; pct: number };

/**
 * "Where fees go" — renders nothing if this token has no FeeRouter (the normal
 * case today). Shows the EFFECTIVE split of the total swap fee (the same shared
 * helper the create preview uses, so the two always agree), the SCHEDULED split +
 * countdown when a change is pending (otherwise it applies now), and — for v2
 * token families — a "Child of $X" / "Children: N · $SELF burned by children: Y"
 * line. Labels and numbers only (UI principles).
 */
export function FeeRouterCard({ token, factory }: { token?: Address; factory?: Address }) {
  const { state, isLoading } = useFeeRouter(token);
  const { split: fee } = useFeeSplit(factory);
  const { family } = useTokenFamily(token);
  const { projects } = useProjects();
  const now = useNow();

  const tickerOf = useMemo(
    () => (addr?: Address) => {
      if (!addr) return undefined;
      const p = projects.find((x) => x.token.toLowerCase() === addr.toLowerCase());
      return p?.symbol ? `$${p.symbol}` : shortAddress(addr);
    },
    [projects],
  );

  const activeParts = useMemo<SplitPart[] | null>(() => {
    if (!state || !fee) return null;
    const router: RouterSplitBps = {
      creatorBps: state.creatorBps,
      treasuryBps: state.treasuryBps,
      buybackBps: state.buybackBps,
      parentBurnBps: state.parentBurnBps,
      rewardsBps: state.rewardsBps,
    };
    return effectiveSplitParts(fee, router);
  }, [state, fee]);

  const pendingParts = useMemo<SplitPart[] | null>(() => {
    if (!state || !fee || !state.hasPendingSplit) return null;
    const router: RouterSplitBps = {
      creatorBps: state.pendingCreatorBps,
      treasuryBps: state.pendingTreasuryBps,
      buybackBps: state.pendingBuybackBps,
      parentBurnBps: state.pendingParentBurnBps,
      rewardsBps: state.pendingRewardsBps,
    };
    return effectiveSplitParts(fee, router);
  }, [state, fee]);

  if (isLoading || !state) return null;

  const effectiveAt = Number(state.pendingEffectiveAt);
  const secsLeft = Math.max(0, effectiveAt - (now > 0 ? now : Math.floor(Date.now() / 1000)));

  const selfTicker = tickerOf(token) ?? "this token";
  const parentTicker = tickerOf(state.parent);

  return (
    <section className="card space-y-4 p-5">
      <h2 className="section-label">Where fees go</h2>

      {/* Family lineage (v2). */}
      {(state.parent || family.childCount > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {state.parent && (
            <span className="chip">Child of {parentTicker ?? shortAddress(state.parent)}</span>
          )}
          {family.childCount > 0 && (
            <span className="chip">
              Children: {family.childCount} · {selfTicker} burned by children: {fmtTokens(family.totalBurnedByChildren)}
            </span>
          )}
        </div>
      )}

      {/* Applies now */}
      <div>
        <div className="eyebrow mb-2">{state.hasPendingSplit ? "Active now" : "Applies now"}</div>
        {activeParts ? (
          <>
            <SplitBar parts={activeParts} />
            <SplitLegend parts={activeParts} />
          </>
        ) : (
          <p className="text-xs text-text-faint">reading fee split…</p>
        )}
      </div>

      {/* Scheduled (pending) */}
      {state.hasPendingSplit && pendingParts && (
        <div className="rounded-input border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">Scheduled</span>
            <span className="text-xs text-text-faint">
              {secsLeft > 0 ? `in ${formatDuration(secsLeft)} · ${formatEt(effectiveAt)}` : `applies on next route · ${formatEt(effectiveAt)}`}
            </span>
          </div>
          <div className="mt-2 opacity-60">
            <SplitBar parts={pendingParts} />
            <SplitLegend parts={pendingParts} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-3 border-t border-border pt-3">
        <Stat label="Tokens burned" value={fmtTokens(state.totalTokenBurned)} />
        {state.parent && <Stat label={`${parentTicker ?? "Parent"} burned`} value={fmtTokens(state.totalParentBurned)} />}
        <Stat label="Rewards paid" value={fmtWeth(state.totalRoutedToRewards)} />
        {state.totalRoutedToTreasury > 0n && <Stat label="Added to treasury" value={fmtWeth(state.totalRoutedToTreasury)} />}
      </div>
    </section>
  );
}

function SplitBar({ parts }: { parts: SplitPart[] }) {
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised">
      {parts.map((p) => (
        <div key={p.key} className={cn(p.color, "h-full")} style={{ width: `${p.pct}%` }} />
      ))}
    </div>
  );
}

function SplitLegend({ parts }: { parts: SplitPart[] }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
      {parts.map((p) => (
        <div key={p.key} className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", p.color)} />
          <span className="text-text-secondary">{p.label}</span>
          <span className="ml-auto font-mono text-text-primary">{p.pct}%</span>
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
