"use client";

import type { Address } from "viem";
import type { QuoteAssetCandidate } from "@/hooks/useQuoteAssets";
import { availablePresets } from "@/lib/launchTemplates";
import { cn } from "@/lib/cn";

// Theme presets above the pool-pairing picker (Section B of the growth
// backlog). Each is a pure shortcut into existing form state (quote-asset
// picks + the description textarea) — no contract call, no new validation,
// no launch-mechanics change. The resolve/filter logic lives in
// lib/launchTemplates.ts (pure, unit-tested); this component only wires it
// to the live `candidates` the create flow's picker already reads from
// useQuoteAssets, so a preset can never show an asset that isn't confirmed
// green against the CURRENT factory today.
export function LaunchTemplates({
  candidates,
  maxQuotes,
  onApply,
}: {
  candidates: QuoteAssetCandidate[];
  maxQuotes: number;
  onApply: (addresses: Address[], description: string) => void;
}) {
  const available = availablePresets(candidates, maxQuotes);
  if (available.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="eyebrow">Templates</div>
      <div className="flex flex-wrap gap-2">
        {available.map(({ preset, addresses }) => (
          <button
            key={preset.key}
            type="button"
            onClick={() => onApply(addresses, preset.description)}
            className={cn("tab", "tab-idle")}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
