"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";

const BPS = 10000;

type PresetKey = "creator" | "treasury" | "buyback" | "rewards" | "custom";

const PRESETS: { key: PresetKey; label: string; split: FeeSplitBps; disabled?: boolean }[] = [
  { key: "creator", label: "All to me", split: { creatorBps: BPS, treasuryBps: 0, buybackBps: 0, rewardsBps: 0 } },
  { key: "treasury", label: "Grow treasury", split: { creatorBps: 0, treasuryBps: BPS, buybackBps: 0, rewardsBps: 0 }, disabled: true },
  { key: "buyback", label: "Buyback & burn", split: { creatorBps: 0, treasuryBps: 0, buybackBps: BPS, rewardsBps: 0 } },
  { key: "rewards", label: "Reward stakers", split: { creatorBps: 0, treasuryBps: 0, buybackBps: 0, rewardsBps: BPS } },
  { key: "custom", label: "Custom", split: { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, rewardsBps: 2500 } },
];

const BUCKETS: { key: keyof FeeSplitBps; label: string; color: string; disabled?: boolean }[] = [
  { key: "creatorBps", label: "Creator", color: "bg-green" },
  { key: "treasuryBps", label: "Treasury", color: "bg-bone/30", disabled: true },
  { key: "buybackBps", label: "Buyback & burn", color: "bg-warning" },
  { key: "rewardsBps", label: "Stakers", color: "bg-accent" },
];

/**
 * Where a launch's trading fees go, in bps across four buckets (sum 10000,
 * default 100% creator — matches FeeRouter's own default). The treasury bucket
 * is disabled here: its swap needs a verified WETH/asset pool key
 * (docs/FEE_ROUTER_DESIGN.md §2.4) that isn't resolvable client-side yet, so
 * shipping it half-working would be worse than shipping it later. Selecting
 * anything other than "All to me" routes the launch through FeeRouterFactory
 * instead of calling BallastFactory.launch() directly — see
 * useFeeRouterLaunchRunner.
 */
export function FeesSection({ split, onChange }: { split: FeeSplitBps; onChange: (s: FeeSplitBps) => void }) {
  const [preset, setPreset] = useState<PresetKey>("creator");

  function applyPreset(p: (typeof PRESETS)[number]) {
    if (p.disabled) return;
    setPreset(p.key);
    onChange(p.split);
  }

  function setBucket(key: keyof FeeSplitBps, value: number) {
    setPreset("custom");
    // Clamp the dragged slider so the OTHER non-creator buckets it isn't
    // touching still fit within 100%, then absorb whatever's left into
    // "Creator" — this can never go negative, so every reachable slider
    // position is a valid (sums-to-10000) split by construction.
    const otherBuckets = (Object.keys(split) as (keyof FeeSplitBps)[]).filter((k) => k !== key && k !== "creatorBps");
    const othersTotal = otherBuckets.reduce((sum, k) => sum + split[k], 0);
    const clamped = Math.min(value, BPS - othersTotal);
    const next = { ...split, [key]: clamped };
    next.creatorBps = BPS - othersTotal - clamped;
    onChange(next);
  }

  const total = split.creatorBps + split.treasuryBps + split.buybackBps + split.rewardsBps;

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p)}
            disabled={p.disabled}
            className={cn("tab", preset === p.key ? "tab-active" : "tab-idle", p.disabled && "cursor-not-allowed opacity-40")}
            title={p.disabled ? "Coming soon" : undefined}
          >
            {p.label}
            {p.disabled && <span className="ml-1 text-text-faint">·soon</span>}
          </button>
        ))}
      </div>

      {/* Live split preview — four segments, labels + percentages only. */}
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised">
        {BUCKETS.map((b) => {
          const pct = split[b.key] / 100;
          if (pct <= 0) return null;
          return <div key={b.key} className={cn(b.color, "h-full")} style={{ width: `${pct}%` }} />;
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {BUCKETS.map((b) => (
          <div key={b.key} className={cn("flex items-center gap-1.5", b.disabled && "opacity-40")}>
            <span className={cn("h-2 w-2 rounded-full", b.color)} />
            <span className="text-text-secondary">{b.label}</span>
            <span className="ml-auto font-mono text-text-primary">{(split[b.key] / 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>

      {preset === "custom" && (
        <div className="space-y-3 border-t border-border pt-3">
          {BUCKETS.filter((b) => !b.disabled).map((b) => (
            <label key={b.key} className="block">
              <div className="mb-1 flex justify-between text-xs text-text-secondary">
                <span>{b.label}</span>
                <span className="font-mono">{(split[b.key] / 100).toFixed(0)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={BPS}
                step={100}
                value={split[b.key]}
                onChange={(e) => setBucket(b.key, Number(e.target.value))}
                className="w-full"
              />
            </label>
          ))}
        </div>
      )}

      {total !== BPS && <p className="text-xs text-negative">Split must sum to 100% (currently {(total / 100).toFixed(0)}%).</p>}

      {preset !== "creator" && (
        <p className="text-xs text-text-faint">Your fees route through this page instead of straight to your wallet.</p>
      )}
    </section>
  );
}
