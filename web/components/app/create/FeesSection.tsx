"use client";

import { useMemo, useState } from "react";
import type { Address } from "viem";
import { cn } from "@/lib/cn";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";
import { useProjects } from "@/hooks/useProjects";
import { WETH_ADDRESS, isHiddenToken, isRetiredToken } from "@/lib/contracts";
import { shortAddress } from "@/lib/format";

const BPS = 10000;

type PresetKey = "creator" | "treasury" | "buyback" | "rewards" | "custom";

const PRESETS: { key: PresetKey; label: string; split: FeeSplitBps; disabled?: boolean }[] = [
  { key: "creator", label: "All to me", split: { creatorBps: BPS, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 } },
  { key: "treasury", label: "Grow treasury", split: { creatorBps: 0, treasuryBps: BPS, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 }, disabled: true },
  { key: "buyback", label: "Buyback & burn", split: { creatorBps: 0, treasuryBps: 0, buybackBps: BPS, parentBurnBps: 0, rewardsBps: 0 } },
  { key: "rewards", label: "Reward stakers", split: { creatorBps: 0, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: BPS } },
  { key: "custom", label: "Custom", split: { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, parentBurnBps: 0, rewardsBps: 2500 } },
];

const BUCKETS: { key: keyof Omit<FeeSplitBps, "parent">; label: string; color: string; disabled?: boolean; requiresParent?: boolean }[] = [
  { key: "creatorBps", label: "Creator", color: "bg-green" },
  { key: "treasuryBps", label: "Treasury", color: "bg-bone/30", disabled: true },
  { key: "buybackBps", label: "Buyback & burn", color: "bg-warning" },
  { key: "parentBurnBps", label: "Parent burn", color: "bg-negative", requiresParent: true },
  { key: "rewardsBps", label: "Stakers", color: "bg-accent" },
];

/**
 * Where a launch's trading fees go, in bps across up to five buckets (sum 10000,
 * default 100% creator — matches FeeRouter's own default). The treasury bucket is
 * disabled here: its swap needs a verified WETH/asset pool key
 * (docs/FEE_ROUTER_DESIGN.md §2.4) that isn't resolvable client-side yet. The
 * parentBurn bucket (v2 only, `allowParent`) requires picking a family parent — a
 * Ballast-launched token with a live WETH pool. Selecting anything other than "All
 * to me" routes the launch through the FeeRouter factory instead of calling
 * BallastFactory.launch() directly — see useFeeRouterLaunchRunner.
 */
export function FeesSection({
  split,
  onChange,
  allowParent,
  lockParent,
  thisTokenSymbol,
}: {
  split: FeeSplitBps;
  onChange: (s: FeeSplitBps) => void;
  allowParent: boolean; // v2 active → the parentBurn bucket + parent picker are available
  lockParent?: boolean; // parent is already fixed (dashboard: it's immutable) — hide the picker, keep the bucket
  thisTokenSymbol?: string;
}) {
  const [preset, setPreset] = useState<PresetKey>("creator");
  const { projects } = useProjects();

  // Candidate parents: Ballast-launched tokens with a live WETH pool. The contract
  // re-validates (NotBallastParent / ParentPoolNotReady), so this is UX-only.
  const parentOptions = useMemo(() => {
    if (!allowParent) return [];
    const weth = WETH_ADDRESS?.toLowerCase();
    return projects
      .filter(
        (p) =>
          !isHiddenToken(p.token) &&
          !isRetiredToken(p.token) &&
          p.hasPool &&
          (!weth || p.quoteAssets.some((q) => q.toLowerCase() === weth)),
      )
      .map((p) => ({ token: p.token, label: p.symbol ? `$${p.symbol}` : shortAddress(p.token) }));
  }, [projects, allowParent]);

  const visibleBuckets = BUCKETS.filter((b) => !b.requiresParent || (allowParent && Boolean(split.parent)));

  function applyPreset(p: (typeof PRESETS)[number]) {
    if (p.disabled) return;
    setPreset(p.key);
    onChange({ ...p.split, parent: split.parent });
  }

  function setBucket(key: keyof Omit<FeeSplitBps, "parent">, value: number) {
    setPreset("custom");
    // Clamp the dragged slider so the OTHER non-creator buckets it isn't touching
    // still fit within 100%, then absorb whatever's left into "Creator" — this can
    // never go negative, so every reachable slider position is a valid split.
    const otherBuckets = (["treasuryBps", "buybackBps", "parentBurnBps", "rewardsBps"] as const).filter((k) => k !== key);
    const othersTotal = otherBuckets.reduce((sum, k) => sum + split[k], 0);
    const clamped = Math.min(value, BPS - othersTotal);
    onChange({ ...split, [key]: clamped, creatorBps: BPS - othersTotal - clamped });
  }

  function setParent(token: Address | undefined) {
    if (!token) {
      // Clearing the parent zeroes the parentBurn bucket and hands it back to creator.
      onChange({ ...split, parent: undefined, creatorBps: split.creatorBps + split.parentBurnBps, parentBurnBps: 0 });
      return;
    }
    onChange({ ...split, parent: token });
  }

  const total = split.creatorBps + split.treasuryBps + split.buybackBps + split.parentBurnBps + split.rewardsBps;

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

      {/* Live split preview — segments, labels + percentages only. */}
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised">
        {visibleBuckets.map((b) => {
          const pct = split[b.key] / 100;
          if (pct <= 0) return null;
          return <div key={b.key} className={cn(b.color, "h-full")} style={{ width: `${pct}%` }} />;
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {visibleBuckets.map((b) => (
          <div key={b.key} className={cn("flex items-center gap-1.5", b.disabled && "opacity-40")}>
            <span className={cn("h-2 w-2 shrink-0 rounded-full", b.color)} />
            <span className="min-w-0 truncate text-text-secondary">{b.label}</span>
            <span className="ml-auto shrink-0 font-mono text-text-primary">{(split[b.key] / 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>

      {/* Family parent picker (v2). Selecting one unlocks the Parent burn bucket.
          Hidden when the parent is already fixed (dashboard: immutable on-chain). */}
      {allowParent && !lockParent && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="section-label">Parent token</span>
            <span className="text-xs text-text-faint">optional · for token families</span>
          </div>
          <select
            value={split.parent ?? ""}
            onChange={(e) => setParent((e.target.value || undefined) as Address | undefined)}
            className="input w-full"
          >
            <option value="">None</option>
            {parentOptions.map((o) => (
              <option key={o.token} value={o.token}>
                {o.label}
              </option>
            ))}
          </select>
          {split.parent && (
            <p className="text-xs text-text-faint">
              A share of this token&apos;s creator fees buys {parentOptions.find((o) => o.token === split.parent)?.label ?? "$PARENT"} and
              sends it to the dead address.
            </p>
          )}
        </div>
      )}

      {preset === "custom" && (
        <div className="space-y-3 border-t border-border pt-3">
          {visibleBuckets.filter((b) => !b.disabled).map((b) => (
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
        <p className="text-xs text-text-faint">
          Your creator fees go to a FeeRouter contract for this token, which splits them on-chain by these percentages.{" "}
          {allowParent
            ? "Lowering your own share applies instantly. Anything else takes effect 7 days after you schedule it."
            : "Changes take effect 7 days after you schedule them."}
          {thisTokenSymbol ? ` Staking rewards are paid in WETH, can be zero.` : ""}
        </p>
      )}
    </section>
  );
}
