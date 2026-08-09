"use client";

import { useReadContracts } from "wagmi";
import { formatUnits, type Address } from "viem";
import type { ProjectBacking } from "@/hooks/useProjects";
import { erc20Abi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { formatUsd, formatBackingPerToken, shortAddress } from "@/lib/format";
import { formatSmallUsd } from "@/lib/market";
import { classifyFreshness, formatEt, type FreshnessTier } from "@/lib/marketHours";
import { cn } from "@/lib/cn";

// The per-asset breakdown that BackingLens returns for a treasury. Rules 8 & 9 are
// satisfied at the SOURCE: the lens reads decimals() per feed (never assumes 8) and
// does NOT re-apply uiMultiplier() (the feed price already includes it). This panel
// therefore only ever RENDERS the lens values — it never re-derives a price and never
// multiplies by anything. `price` is USD, scaled by `priceDecimals`.
type AssetView = {
  asset: Address;
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

const CHAIN_ID = activeChain.id;

function qty(v: bigint, decimals: number): string {
  return Number(formatUnits(v, decimals)).toLocaleString("en", { maximumFractionDigits: 4, notation: "compact" });
}

// Terminal treasury composition — asset by asset: ticker, quantity, Chainlink price,
// USD value, and how long since that feed published. Teaches that a resting equity
// price is normal rather than alarming. Empty state is the COMMON case (most tokens
// hold no treasury) and reads as a fact, not an error.
export function TerminalTreasuryPanel({ backing, now }: { backing?: ProjectBacking; now: number }) {
  const assets = (backing?.assets as unknown as AssetView[] | undefined) ?? [];

  // Tickers aren't in the lens output — read symbol() per asset (usually one).
  const symRes = useReadContracts({
    allowFailure: true,
    contracts: assets.map((a) => ({ address: a.asset, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID }) as const),
    query: { enabled: assets.length > 0 },
  });
  const symbolAt = (i: number) => (symRes.data?.[i]?.status === "success" ? (symRes.data[i].result as string) : undefined);

  if (!backing || backing.totalValueUsd === 0n || assets.length === 0) {
    return (
      <section className="card p-4">
        <h2 className="section-label">Treasury</h2>
        <p className="mt-2 text-sm text-text-secondary">This token holds no treasury.</p>
        <p className="mt-1 text-xs text-text-faint">
          Launched without ballast — nothing to compose here. A fact about the token, not a missing figure.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-4">
      <h2 className="section-label">Treasury composition</h2>

      <ul className="mt-3 space-y-3">
        {assets.map((a, i) => {
          const total = a.lockedBalance + a.withdrawableBalance;
          const valueUsd = a.lockedValueUsd + a.withdrawableValueUsd;
          const fresh =
            a.priced && now > 0 ? classifyFreshness(Number(a.updatedAt), a.marketHours, a.stale, now) : undefined;
          const ticker = symbolAt(i);
          return (
            <li key={a.asset} className="border-t border-border pt-3 first:border-0 first:pt-0">
              <div className="flex items-center justify-between gap-2">
                <a
                  href={`${activeChain.blockExplorers.default.url}/token/${a.asset}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-text-primary hover:text-green"
                  title={a.asset}
                >
                  {ticker ?? shortAddress(a.asset)}
                </a>
                <span className="figure-primary tabular-nums text-sm">
                  {a.priced ? formatUsd(valueUsd, { compact: true }) : "unpriced"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs tabular-nums text-text-faint">
                <span>
                  {qty(total, a.assetDecimals)} {ticker ?? "units"}
                  {a.priced && (
                    <>
                      {" · "}
                      <span title="Chainlink feed price, decimals read from the feed">
                        {formatSmallUsd(Number(formatUnits(a.price, a.priceDecimals)))}
                      </span>
                    </>
                  )}
                </span>
                {fresh ? (
                  <span className="flex items-center gap-1.5">
                    <span className="text-text-faint">{formatEt(Number(a.updatedAt))}</span>
                    <FreshnessChip tier={fresh.tier} label={fresh.label} />
                  </span>
                ) : (
                  <span className="text-warning">no price</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-sm">
        <span className="text-text-faint">Total treasury value</span>
        <span className="figure-primary tabular-nums">{formatUsd(backing.totalValueUsd, { compact: true })}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between text-xs">
        <span className="text-text-faint">Backing per token</span>
        <span className="tabular-nums text-text-secondary">{formatBackingPerToken(backing.backingPerToken)}</span>
      </div>

      <p className="mt-3 text-xs text-text-faint">
        Equity feeds publish on a ~0.5% price move with a 24-hour heartbeat, so a day or three between updates is
        normal — especially over weekends and holidays. <span className="text-text-secondary">Resting</span> means the
        market&apos;s closed or quiet and the last print still stands; <span className="text-text-secondary">stale</span>{" "}
        means we&apos;d expect a fresh print by now and haven&apos;t seen one.
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
