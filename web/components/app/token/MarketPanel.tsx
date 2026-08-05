"use client";

import type { Address } from "viem";
import { useMarket } from "@/hooks/useMarket";
import { formatEt } from "@/lib/marketHours";
import { geckoPoolUrl, geckoEmbedUrl, dexscreenerUrl, dexLabel, formatSmallUsd as smallUsd, formatCompactUsd as compactUsd } from "@/lib/market";

// Token-page market section (Part E). Price/volume/chart/venues come from
// GeckoTerminal — clearly labelled with source + fetch time. The CHAIN always
// governs: if an on-chain market price is available it is shown as authoritative
// and any GeckoTerminal disagreement is flagged. Backing (the reason the product
// exists) is elsewhere and is always chain-only.
export function MarketPanel({
  token,
  symbol,
  chainPriceUsd,
}: {
  token: Address;
  symbol?: string;
  chainPriceUsd?: bigint; // on-chain market price (1e18), if StateView is available
}) {
  const { market, isLoading } = useMarket(token);
  const chainPrice = chainPriceUsd !== undefined ? Number(chainPriceUsd) / 1e18 : undefined;

  if (isLoading) {
    return (
      <section className="card p-5">
        <SectionTitle />
        <div className="mt-4 h-64 animate-pulse rounded-input bg-surface-raised" />
      </section>
    );
  }

  if (!market?.available) {
    const notIndexed = market?.reason === "not-indexed";
    return (
      <section className="card p-5">
        <SectionTitle />
        <div className="mt-4 flex flex-col items-center justify-center rounded-input border border-dashed border-border py-10 text-center">
          <p className="text-sm text-warning">{notIndexed ? "Not on GeckoTerminal yet" : "Market data unreachable"}</p>
          <p className="mt-1 max-w-sm text-xs text-text-faint">
            {notIndexed
              ? "GeckoTerminal lists a pool once it crosses roughly $1,000 of liquidity. Until then there's no external price or chart — we won't draw a fabricated one. Backing above is read live from the chain regardless."
              : "GeckoTerminal didn't respond. Price and chart will appear when it's reachable again; backing above is unaffected (it's read from the chain)."}
          </p>
        </div>
      </section>
    );
  }

  const gt = market.priceUsd;
  // Chain wins: if we have an on-chain price, it is the figure shown; GeckoTerminal
  // is secondary and a >1% disagreement is surfaced.
  const disagree =
    chainPrice !== undefined && gt !== undefined && chainPrice > 0 && Math.abs(gt - chainPrice) / chainPrice > 0.01;

  return (
    <section className="card p-5">
      <SectionTitle />

      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat
          label="Price"
          value={chainPrice !== undefined ? smallUsd(chainPrice) : gt !== undefined ? smallUsd(gt) : "—"}
          source={chainPrice !== undefined ? "on-chain" : "GeckoTerminal"}
        />
        <Stat
          label="24h change"
          value={market.change24hPct != null ? `${market.change24hPct >= 0 ? "+" : ""}${market.change24hPct.toFixed(2)}%` : "—"}
          tone={market.change24hPct == null ? undefined : market.change24hPct >= 0 ? "pos" : "neg"}
          source="GeckoTerminal"
        />
        <Stat label="24h volume" value={market.volume24hUsd !== undefined ? compactUsd(market.volume24hUsd) : "—"} source="GeckoTerminal" />
      </div>

      {disagree && (
        <p className="mt-3 rounded-input border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
          GeckoTerminal shows {smallUsd(gt!)} — it disagrees with the on-chain price by more than 1%. The on-chain
          figure governs; treat the external one as indicative.
        </p>
      )}

      {/* Chart — GeckoTerminal embed for the deepest pool, not a chart we built. */}
      {market.top && (
        <div className="mt-4 overflow-hidden rounded-input border border-border">
          <iframe
            title={`${symbol ?? "token"} price chart (GeckoTerminal)`}
            src={geckoEmbedUrl(market.top.address)}
            className="h-[360px] w-full"
            loading="lazy"
            allow="clipboard-write"
          />
        </div>
      )}

      {/* Trade elsewhere — every venue where the token has liquidity. */}
      {market.pools.length > 0 && (
        <div className="mt-4">
          <h3 className="field-label mb-2 text-text-faint">Trade elsewhere</h3>
          <ul className="space-y-1.5">
            {market.pools.map((p) => (
              <li key={p.address} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="text-text-primary">{dexLabel(p.dexId)}</span>
                  <span className="metric-secondary ml-2">{compactUsd(p.reserveUsd)} liq · {compactUsd(p.volume24hUsd)} 24h</span>
                </span>
                <span className="flex shrink-0 gap-3 text-xs">
                  <a className="text-green underline underline-offset-2" href={geckoPoolUrl(p.address)} target="_blank" rel="noreferrer">
                    GeckoTerminal ↗
                  </a>
                  <a className="text-text-muted underline underline-offset-2 hover:text-text-secondary" href={dexscreenerUrl(p.address)} target="_blank" rel="noreferrer">
                    DexScreener ↗
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-[11px] text-text-faint">
        Price, volume, chart and venues via GeckoTerminal
        {market.fetchedAt ? ` · updated ${formatEt(market.fetchedAt)}` : ""}. Backing is read live from the chain and
        is independent of this.
      </p>
    </section>
  );
}

function SectionTitle() {
  return <h2 className="section-label">Market</h2>;
}

function Stat({ label, value, source, tone }: { label: string; value: string; source: string; tone?: "pos" | "neg" }) {
  return (
    <div>
      <div className="field-label mb-0 text-text-faint">{label}</div>
      <div
        className={`mt-1 figure-primary text-xl ${tone === "pos" ? "text-positive" : tone === "neg" ? "text-negative" : ""}`}
      >
        {value}
      </div>
      <div className="metric-secondary">{source}</div>
    </div>
  );
}

