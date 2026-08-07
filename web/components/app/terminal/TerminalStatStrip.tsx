"use client";

import { useState } from "react";
import type { Address } from "viem";
import { Logo } from "@/components/app/Logo";
import { Freshness } from "@/components/app/Freshness";
import { shortAddress, formatBackingPerToken } from "@/lib/format";
import { formatSmallUsd, formatCompactUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

// The terminal's top strip: identity + the four figures you actually watch move —
// Price, Backing per token, 24h change, 24h volume — each with a freshness dot. The
// reference figures (market cap, liquidity, supply) live in the right column, not
// here (they don't change on the timescale you're trading on). Backing sits BESIDE
// price, never beneath it, and an unbacked token reads "not ballasted" plainly rather
// than showing a zero (spec §"Backing, as a first-class figure").
export function TerminalStatStrip({
  token,
  symbol,
  name,
  logoSrc,
  metaWithheld,
  priceUsd1e18,
  priceFallbackNum,
  ballasted,
  backingPerToken1e18,
  change24hPct,
  volume24hUsd,
  marketFetchedAt,
  now,
}: {
  token: Address;
  symbol?: string;
  name?: string;
  logoSrc?: string;
  metaWithheld?: boolean;
  priceUsd1e18?: bigint; // on-chain price (wins when present)
  priceFallbackNum?: number; // GeckoTerminal price (labelled fallback)
  ballasted: boolean;
  backingPerToken1e18?: bigint;
  change24hPct?: number | null;
  volume24hUsd?: number;
  marketFetchedAt?: number; // unix seconds
  now: number;
}) {
  const price =
    priceUsd1e18 !== undefined
      ? formatBackingPerToken(priceUsd1e18)
      : priceFallbackNum !== undefined
        ? formatSmallUsd(priceFallbackNum)
        : "—";
  const priceOnChain = priceUsd1e18 !== undefined;

  return (
    <section className="card flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-3 pr-2">
        <Logo src={logoSrc} symbol={symbol} size={36} />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="truncate font-serif text-lg font-semibold leading-tight text-bone">
              {symbol ?? shortAddress(token)}
            </h1>
            <span className="truncate text-xs text-text-muted">
              {metaWithheld ? <span className="italic text-text-faint">Metadata withheld</span> : (name ?? "Unnamed project")}
            </span>
          </div>
          <CopyAddress address={token} />
        </div>
      </div>

      <div className="hidden h-8 w-px bg-border sm:block" aria-hidden />

      {/* Figures — the four you watch */}
      <Figure label="Price" value={price}>
        <Freshness updatedAt={priceOnChain ? now : marketFetchedAt} source={priceOnChain ? "on-chain" : "GeckoTerminal"} />
      </Figure>

      <Figure
        label="Backing / token"
        value={ballasted && backingPerToken1e18 !== undefined ? formatBackingPerToken(backingPerToken1e18) : "not ballasted"}
        muted={!ballasted}
      >
        {ballasted ? <Freshness updatedAt={now} source="on-chain" /> : <span className="text-xs text-text-faint">no treasury</span>}
      </Figure>

      <Figure
        label="24h change"
        value={change24hPct != null ? `${change24hPct >= 0 ? "+" : ""}${change24hPct.toFixed(2)}%` : "—"}
        tone={change24hPct == null ? undefined : change24hPct >= 0 ? "up" : "down"}
      >
        <Freshness updatedAt={marketFetchedAt} source="GeckoTerminal" />
      </Figure>

      <Figure label="24h volume" value={volume24hUsd !== undefined ? formatCompactUsd(volume24hUsd) : "—"}>
        <Freshness updatedAt={marketFetchedAt} source="GeckoTerminal" />
      </Figure>
    </section>
  );
}

function Figure({
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
    <div className="min-w-[92px]">
      <div className="eyebrow">{label}</div>
      <div
        className={cn(
          "figure-primary mt-0.5 text-lg tabular-nums leading-tight",
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

function CopyAddress({ address }: { address: Address }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-text-faint transition-colors hover:text-text-secondary"
      title={`Copy ${address}`}
    >
      {copied ? "Copied ✓" : shortAddress(address)}
    </button>
  );
}
