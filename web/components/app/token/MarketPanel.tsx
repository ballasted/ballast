"use client";

import type { Address } from "viem";
import { useMarket } from "@/hooks/useMarket";
import { formatEt } from "@/lib/marketHours";
import { geckoPoolUrl, dexscreenerUrl, dexLabel, formatSmallUsd as smallUsd, formatCompactUsd as compactUsd } from "@/lib/market";
import { candidatePoolKeys } from "@/lib/pool";
import { WETH_ADDRESS } from "@/lib/contracts";

// Token-page "Markets" section. Price/volume now live in the stat row and the chart
// is drawn natively, so this section is the cross-venue list plus the ONE thing it
// uniquely owns: a check that the external (GeckoTerminal) price agrees with the
// on-chain one. The chain always governs; a >1% disagreement is surfaced, never
// silently reconciled. Backing is elsewhere and is always chain-only.
export function MarketPanel({
  token,
  chainPriceUsd,
}: {
  token: Address;
  chainPriceUsd?: bigint; // on-chain market price (1e18), if StateView is available
}) {
  const { market, isLoading } = useMarket(token);
  const chainPrice = chainPriceUsd !== undefined ? Number(chainPriceUsd) / 1e18 : undefined;

  if (isLoading) {
    return (
      <section className="card p-5">
        <h2 className="section-label">Markets</h2>
        <div className="mt-4 h-24 animate-pulse rounded-input bg-surface-raised" />
      </section>
    );
  }

  if (!market?.available) {
    const notIndexed = market?.reason === "not-indexed";
    return (
      <section className="card p-5">
        <h2 className="section-label">Markets</h2>
        <p className="mt-3 text-sm text-warning">{notIndexed ? "Not on GeckoTerminal yet" : "Market data unreachable"}</p>
        <p className="mt-1 max-w-md text-xs text-text-faint">
          {notIndexed
            ? "GeckoTerminal lists a pool once it clears ~$1,000 liquidity. Until then there's no venue list — backing and price above are chain-read regardless."
            : "GeckoTerminal didn't respond. Venues will appear when it's reachable again; backing and price above are unaffected (chain-read)."}
        </p>
      </section>
    );
  }

  const gt = market.priceUsd;
  const disagree =
    chainPrice !== undefined && gt !== undefined && chainPrice > 0 && Math.abs(gt - chainPrice) / chainPrice > 0.01;

  // A token can genuinely have several real Uniswap v4 pools indexed —
  // one per hook generation (each hook redeploy strands the prior pool's
  // liquidity behind, per lib/pool.ts's candidatePoolKeys). v4 pools have no
  // deployed contract address, so GeckoTerminal indexes them by poolId
  // (bytes32) — compare each listed pool's address against the SAME poolId
  // computation this app already uses to resolve a token's pool across hook
  // generations, newest-first. Index 0 is the current, active generation;
  // anything after is real but fragmented liquidity left on a prior hook. A
  // pool address that matches none of them (a different venue/DEX entirely)
  // is left unlabeled rather than guessed at.
  const hookGenerations = WETH_ADDRESS ? candidatePoolKeys(token, WETH_ADDRESS) : [];
  function poolGeneration(poolAddress: string): "current" | "prior" | undefined {
    const idx = hookGenerations.findIndex((c) => c.id.toLowerCase() === poolAddress.toLowerCase());
    if (idx === 0) return "current";
    if (idx > 0) return "prior";
    return undefined;
  }

  return (
    <section className="card p-5">
      <h2 className="section-label">Markets</h2>

      {disagree && (
        <p className="mt-3 rounded-input border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
          GeckoTerminal shows {smallUsd(gt!)}, off the on-chain price by &gt;1%. On-chain governs; treat this as
          indicative.
        </p>
      )}

      {market.pools.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {market.pools.map((p) => {
            const gen = poolGeneration(p.address);
            return (
            <li key={p.address} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="text-text-primary">{dexLabel(p.dexId)}</span>
                {gen === "current" && <span className="chip chip-accent ml-2">Current</span>}
                {gen === "prior" && <span className="chip chip-neutral ml-2">Prior pool</span>}
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
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-text-muted">No external venues indexed yet.</p>
      )}

      <p className="mt-4 text-[11px] text-text-faint">
        Venues via GeckoTerminal{market.fetchedAt ? ` · updated ${formatEt(market.fetchedAt)}` : ""}. Backing and price
        are chain-read, independent of this.
      </p>
    </section>
  );
}
