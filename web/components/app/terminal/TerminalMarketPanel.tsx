"use client";

import { Freshness } from "@/components/app/Freshness";
import { formatUsd } from "@/lib/format";
import { formatCompactUsd, marketCapUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

// Market reference: the figures moved OUT of the top strip because you don't watch
// them move — market cap, liquidity, supply. "locked" and "fixed" aren't decoration:
// they're facts other launchpads on this chain can't print, so they stay labelled.
export function TerminalMarketPanel({
  marketPriceUsd,
  supply,
  liquidityUsd,
  now,
  marketFetchedAt,
}: {
  marketPriceUsd?: bigint;
  supply?: bigint;
  liquidityUsd?: number; // GeckoTerminal top-pool reserve
  now: number;
  marketFetchedAt?: number;
}) {
  const mcap = supply !== undefined ? marketCapUsd(marketPriceUsd, supply) : undefined;
  return (
    <section className="card p-4">
      <h2 className="section-label">Market</h2>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <Ref label="Market cap" value={mcap !== undefined ? formatUsd(mcap, { compact: true }) : "—"} source="on-chain" updatedAt={now} />
        <Ref
          label="Liquidity · locked"
          value={liquidityUsd !== undefined ? formatCompactUsd(liquidityUsd) : "—"}
          source="GeckoTerminal"
          updatedAt={marketFetchedAt}
        />
        <Ref
          label="Supply · fixed"
          value={supply !== undefined ? Number(supply / 10n ** 18n).toLocaleString("en", { notation: "compact" }) : "—"}
          source="on-chain"
          updatedAt={now}
        />
      </dl>
      <p className="mt-3 text-xs text-text-faint">
        Market cap is price × total supply, computed live. The pool liquidity is seeded and permanently locked, and the
        supply is fixed at launch — there is no mint function.
      </p>
    </section>
  );
}

function Ref({
  label,
  value,
  source,
  updatedAt,
}: {
  label: string;
  value: string;
  source: string;
  updatedAt?: number;
}) {
  return (
    <div className={cn("min-w-0")}>
      <dt className="eyebrow">{label}</dt>
      <dd className="figure-primary mt-0.5 truncate text-lg tabular-nums">{value}</dd>
      <Freshness className="mt-0.5" updatedAt={updatedAt} source={source} />
    </div>
  );
}
