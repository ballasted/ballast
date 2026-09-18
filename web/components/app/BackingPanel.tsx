"use client";

import type { ProjectBacking } from "@/hooks/useProjects";
import { formatUsd, formatBackingPerToken } from "@/lib/format";
import { classifyFreshness, formatEt, type FreshnessTier } from "@/lib/marketHours";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

type AssetView = {
  asset: `0x${string}`;
  lockedBalance: bigint;
  withdrawableBalance: bigint;
  price: bigint;
  priceDecimals: number;
  assetDecimals: number;
  updatedAt: bigint;
  marketHours: number;
  lockedValueUsd: bigint;
  withdrawableValueUsd: bigint;
  priced: boolean;
  stale: boolean;
  oraclePaused: boolean;
};

const SEQ = ["Unknown", "Up", "GracePeriod", "Down"] as const;

// Verified backing panel (build-spec §9). The backing figure and its timestamp are
// ONE component — never rendered apart. The no-claim disclaimer is INSIDE this
// panel, not a footer (hard rule 5).
export function BackingPanel({
  backing,
  symbol,
  now,
}: {
  backing: ProjectBacking;
  symbol: string;
  now: number;
}) {
  const assets = backing.assets as unknown as AssetView[];
  const priced = assets.filter((a) => a.priced);

  const locked = backing.lockedValueUsd;
  const withdrawable = backing.withdrawableValueUsd;
  const total = backing.totalValueUsd;
  const lockedPct = total > 0n ? Number((locked * 10000n) / total) / 100 : 0;

  const withdrawablePerToken = backing.backingPerToken - backing.lockedBackingPerToken;

  // Timestamp/freshness from the oldest priced asset (worst case).
  const oldest = priced.reduce<AssetView | undefined>(
    (acc, a) => (!acc || a.updatedAt < acc.updatedAt ? a : acc),
    undefined,
  );
  const fresh =
    oldest && now > 0
      ? classifyFreshness(Number(oldest.updatedAt), oldest.marketHours, oldest.stale, now)
      : undefined;

  const seq = SEQ[backing.sequencerStatus] ?? "Unknown";

  return (
    <section className="card border-accent p-5">
      <h2 className="section-label">
        Verified backing
      </h2>

      {/* Combined backing per token — the headline figure. Keyed by its formatted
          value so a change crossfades the settled figure in; it never counts up
          toward a value (that would read as growth — a claim we don't make). */}
      <div className="mt-3 flex items-baseline gap-2">
        <span key={formatBackingPerToken(backing.backingPerToken)} className="figure-primary anim-fade text-3xl">
          {formatBackingPerToken(backing.backingPerToken)}
        </span>
        <span className="metric-secondary">backing per token</span>
      </div>

      {/* Split bar: locked forever vs creator-withdrawable. */}
      <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-border">
        <div className="bar-grow bg-green" style={{ width: `${lockedPct}%` }} title="Locked forever" />
        <div className="bg-text-faint" style={{ width: `${100 - lockedPct}%` }} title="Creator-withdrawable" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Split
          label="Locked forever"
          color="text-green"
          total={formatUsd(locked, { compact: true })}
          perToken={formatBackingPerToken(backing.lockedBackingPerToken)}
        />
        <Split
          label="Creator-withdrawable"
          color="text-text-muted"
          total={formatUsd(withdrawable, { compact: true })}
          perToken={formatBackingPerToken(withdrawablePerToken)}
        />
      </div>

      {/* Meander divider (spec 4.2) separating the split from the valuation stamp. */}
      <Meander className="my-4" />

      {/* Backing figure + timestamp: one unit. Never shown apart. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {oldest ? (
          <>
            <span className="text-text-faint" title="When the oldest priced treasury asset last updated">
              {formatEt(Number(oldest.updatedAt))}
            </span>
            {fresh && <FreshnessChip tier={fresh.tier} label={fresh.label} />}
          </>
        ) : (
          <span className="text-text-muted">No priced assets</span>
        )}
        {backing.anyUnpriced && (
          <span className="chip chip-warning" title="Some assets could not be priced and are excluded from the total">
            Unpriced assets excluded
          </span>
        )}
        {seq === "Unknown" && (
          <span className="chip chip-neutral" title="No L2 sequencer uptime feed exists for this chain — we did not check it">
            Sequencer unverifiable
          </span>
        )}
        {(seq === "Down" || seq === "GracePeriod") && (
          <span className="chip chip-warning" title="Prices not currently trusted">
            Sequencer {seq === "Down" ? "down" : "recovering"}
          </span>
        )}
      </div>

      {/* Disclaimer — INSIDE the panel, hard rule 5. */}
      <p className="mt-4 rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
        Holding ${symbol || "TICKER"} gives no claim, redemption right, or entitlement
        to these assets.
      </p>
    </section>
  );
}

function Split({
  label,
  color,
  total,
  perToken,
}: {
  label: string;
  color: string;
  total: string;
  perToken: string;
}) {
  return (
    <div>
      <div className={cn("text-xs font-medium", color)}>{label}</div>
      <div className="figure-primary mt-0.5 text-lg">{perToken}</div>
      <div className="metric-secondary">{total} total</div>
    </div>
  );
}

function FreshnessChip({ tier, label }: { tier: FreshnessTier; label: string }) {
  const styles: Record<FreshnessTier, string> = {
    fresh: "chip-accent",
    resting: "chip-neutral",
    stale: "chip-warning",
  };
  const icon = tier === "fresh" ? "●" : tier === "resting" ? "◴" : "⚠";
  return (
    <span className={cn("chip shrink-0", styles[tier])}>
      {icon} {label}
    </span>
  );
}
