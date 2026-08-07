"use client";

import type { ProjectBacking } from "@/hooks/useProjects";
import { formatUsd, formatBackingPerToken } from "@/lib/format";
import { classifyFreshness, formatEt, type FreshnessTier } from "@/lib/marketHours";
import { cn } from "@/lib/cn";

// Only the fields this compact panel needs off each asset (the full AssetView lives
// in the token-page BackingPanel). We read the oldest priced asset for the stamp.
type AssetView = {
  updatedAt: bigint;
  marketHours: number;
  stale: boolean;
  priced: boolean;
};

const SEQ = ["Unknown", "Up", "GracePeriod", "Down"] as const;

// Terminal backing panel — the dense rail form of the verified-backing disclosure.
// Carries backing per token, total treasury value, the valuation stamp, the approved
// line on how market price relates to backing, and the no-claim disclaimer INSIDE the
// panel (hard rule 5). The per-asset breakdown is a SEPARATE panel (Treasury
// composition, next slice), so this stays compact. An unbacked token reads "not
// ballasted" plainly — never a zero (spec §"Backing, as a first-class figure").
export function TerminalBackingPanel({
  backing,
  symbol,
  now,
}: {
  backing?: ProjectBacking;
  symbol: string;
  now: number;
}) {
  const ballasted = Boolean(backing && backing.totalValueUsd > 0n);

  if (!ballasted) {
    return (
      <section className="card p-4">
        <h2 className="section-label">Backing</h2>
        <div className="figure-primary mt-2 text-2xl text-text-muted">not ballasted</div>
        <p className="mt-2 text-xs text-text-faint">
          This token holds no verified on-chain treasury, so there is no backing figure to show — not a zero to be
          misread as one.
        </p>
      </section>
    );
  }

  const b = backing!;
  const assets = b.assets as unknown as AssetView[];
  const priced = assets.filter((a) => a.priced);
  const oldest = priced.reduce<AssetView | undefined>(
    (acc, a) => (!acc || a.updatedAt < acc.updatedAt ? a : acc),
    undefined,
  );
  const fresh =
    oldest && now > 0 ? classifyFreshness(Number(oldest.updatedAt), oldest.marketHours, oldest.stale, now) : undefined;
  const seq = SEQ[b.sequencerStatus] ?? "Unknown";

  return (
    <section className="card border-accent p-4">
      <h2 className="section-label">Verified backing</h2>

      {/* Headline. Keyed by its formatted value so a change crossfades the settled
          figure in — it never counts up (that would read as growth we don't claim). */}
      <div className="mt-2 flex items-baseline gap-2">
        <span key={formatBackingPerToken(b.backingPerToken)} className="figure-primary anim-fade text-2xl">
          {formatBackingPerToken(b.backingPerToken)}
        </span>
        <span className="metric-secondary">backing per token</span>
      </div>

      <div className="mt-2 flex items-center justify-between text-sm">
        <span className="text-text-faint">Total treasury value</span>
        <span className="tabular-nums text-text-secondary">{formatUsd(b.totalValueUsd, { compact: true })}</span>
      </div>

      {/* Valuation stamp — the figure and its timestamp are one unit, never apart. */}
      {oldest ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <span className="text-text-faint">Equities valued at {formatEt(Number(oldest.updatedAt))}</span>
          {fresh && <FreshnessChip tier={fresh.tier} label={fresh.label} />}
        </div>
      ) : (
        <p className="mt-2 text-xs text-text-muted">No priced assets to value.</p>
      )}

      {b.anyUnpriced && (
        <p className="mt-2 text-xs text-warning">Some assets couldn&apos;t be priced and are excluded from the total.</p>
      )}
      {seq === "Unknown" && (
        <p className="mt-2 text-xs text-text-muted">
          Sequencer status unverifiable on this chain — no L2 uptime feed exists yet. We didn&apos;t check it and
          don&apos;t imply we did.
        </p>
      )}
      {(seq === "Down" || seq === "GracePeriod") && (
        <p className="mt-2 text-xs text-warning">
          Sequencer {seq === "Down" ? "is down" : "recently recovered"} — prices not currently trusted.
        </p>
      )}

      {/* Approved relationship line (docs/Ballast-terminal — the price-vs-backing
          decision: no ratio; state plainly that price can trade below backing). */}
      <p className="mt-3 text-xs text-text-secondary">
        Market price is set by trading, not by the treasury. It can — and at times will — trade below the backing
        figure, and nothing holds it there.
      </p>

      {/* No-claim disclaimer — INSIDE the panel, hard rule 5. */}
      <p className="mt-3 rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
        Holding ${symbol || "TICKER"} gives no claim, redemption right, or entitlement to these assets.
      </p>
    </section>
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
