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
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">
        Verified backing
      </h2>

      {/* Combined backing per token — the headline figure. */}
      <div className="mt-3 flex items-baseline gap-2">
        <span className="figure-primary text-3xl">
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
      <div className="text-sm">
        {oldest ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-text-secondary">
              Equities valued at {formatEt(Number(oldest.updatedAt))}
            </span>
            {fresh && <FreshnessChip tier={fresh.tier} label={fresh.label} />}
          </div>
        ) : (
          <span className="text-text-muted">No priced assets to value.</span>
        )}

        {backing.anyUnpriced && (
          <p className="mt-2 text-xs text-warning">
            Some assets could not be priced and are excluded from the total.
          </p>
        )}
        {seq === "Unknown" && (
          <p className="mt-2 text-xs text-text-muted">
            Sequencer status unverifiable on this chain — no L2 uptime feed exists yet.
            We did not check it; we do not imply we did.
          </p>
        )}
        {(seq === "Down" || seq === "GracePeriod") && (
          <p className="mt-2 text-xs text-warning">
            Sequencer {seq === "Down" ? "is down" : "recently recovered"} — prices not
            currently trusted.
          </p>
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
    fresh: "bg-green-bg text-green",
    resting: "bg-card text-text-muted border border-border",
    stale: "bg-warning-bg text-warning",
  };
  const icon = tier === "fresh" ? "●" : tier === "resting" ? "◴" : "⚠";
  return (
    <span className={cn("shrink-0 rounded px-2 py-0.5 text-xs", styles[tier])}>
      {icon} {label}
    </span>
  );
}
