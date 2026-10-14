"use client";

import type { Address } from "viem";
import { useFeeSplit } from "@/hooks/useFeeSplit";

/**
 * The launch's swap-fee split, read LIVE from the FeeConfig of the factory that
 * launched it (`factory`). A gen-4 launch shows 80% creator / 20% platform / 0;
 * a gen-1..3 launch shows its own 50 / 35 / 15 on ITS page — the split is
 * resolved per owning-factory, never from one global config. Labels + numbers
 * only (UI principles). Renders nothing until the live read resolves.
 */
export function FeeSplitInfo({ factory }: { factory?: Address }) {
  const { split, isLoading } = useFeeSplit(factory);
  if (isLoading || !split) return null;

  return (
    <section className="card p-5">
      <h2 className="section-label">Swap fee</h2>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="figure-primary text-xl tabular-nums">{split.feePct}%</span>
        <span className="metric-secondary">per swap</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Cell label="Creator" value={`${split.creatorPct}%`} accent />
        <Cell label="Platform" value={`${split.platformPct}%`} />
        <Cell label="Referrer" value={`${split.referrerPct}%`} />
      </div>
    </section>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-text-faint">{label}</div>
      <div className={`mt-0.5 font-mono text-sm tabular-nums ${accent ? "text-green" : "text-text-primary"}`}>{value}</div>
    </div>
  );
}
