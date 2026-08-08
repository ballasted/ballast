"use client";

import { Freshness } from "@/components/app/Freshness";
import { formatBackingPerToken } from "@/lib/format";
import { formatSmallUsd, formatCompactUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

// The stat row above the chart on the token page — the figures a reader wants first,
// in one line, each with its source + age. Backing per token sits BESIDE price (never
// beneath, never as a ratio), and an unbacked token reads "not ballasted", never a
// zero. Mirrors pools.trade's anchoring stat row, but every figure here is sourced.
export function TokenStatRow({
  priceUsd1e18,
  priceFallbackNum,
  ballasted,
  backingPerToken1e18,
  change24hPct,
  volume24hUsd,
  liquidityUsd,
  holdersCount,
  now,
  marketFetchedAt,
}: {
  priceUsd1e18?: bigint;
  priceFallbackNum?: number;
  ballasted: boolean;
  backingPerToken1e18?: bigint;
  change24hPct?: number | null;
  volume24hUsd?: number;
  liquidityUsd?: number;
  holdersCount?: number;
  now: number;
  marketFetchedAt?: number;
}) {
  const priceOnChain = priceUsd1e18 !== undefined;
  const price = priceOnChain
    ? formatBackingPerToken(priceUsd1e18!)
    : priceFallbackNum !== undefined
      ? formatSmallUsd(priceFallbackNum)
      : "—";

  return (
    <section className="card grid grid-cols-2 gap-x-4 gap-y-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
      <Tile label="Price" value={price}>
        <Freshness updatedAt={priceOnChain ? now : marketFetchedAt} source={priceOnChain ? "on-chain" : "GeckoTerminal"} />
      </Tile>
      <Tile
        label="Backing / token"
        value={ballasted && backingPerToken1e18 !== undefined ? formatBackingPerToken(backingPerToken1e18) : "not ballasted"}
        muted={!ballasted}
      >
        {ballasted ? <Freshness updatedAt={now} source="on-chain" /> : <span className="text-xs text-text-faint">no treasury</span>}
      </Tile>
      <Tile
        label="24h change"
        value={change24hPct != null ? `${change24hPct >= 0 ? "+" : ""}${change24hPct.toFixed(2)}%` : "—"}
        tone={change24hPct == null ? undefined : change24hPct >= 0 ? "up" : "down"}
      >
        <Freshness updatedAt={marketFetchedAt} source="GeckoTerminal" />
      </Tile>
      <Tile label="24h volume" value={volume24hUsd !== undefined ? formatCompactUsd(volume24hUsd) : "—"}>
        <Freshness updatedAt={marketFetchedAt} source="GeckoTerminal" />
      </Tile>
      <Tile label="Liquidity · locked" value={liquidityUsd !== undefined ? formatCompactUsd(liquidityUsd) : "—"}>
        <Freshness updatedAt={marketFetchedAt} source="GeckoTerminal" />
      </Tile>
      <Tile label="Holders" value={holdersCount !== undefined ? holdersCount.toLocaleString("en") : "—"}>
        <Freshness updatedAt={marketFetchedAt} source="Blockscout" />
      </Tile>
    </section>
  );
}

function Tile({
  label,
  value,
  children,
  tone,
  muted,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
  tone?: "up" | "down";
  muted?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div
        className={cn(
          "figure-primary mt-0.5 truncate text-lg tabular-nums",
          tone === "up" && "text-positive",
          tone === "down" && "text-negative",
          muted && "text-text-muted",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
