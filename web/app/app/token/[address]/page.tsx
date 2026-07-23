"use client";

import { useParams } from "next/navigation";
import { useMemo } from "react";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useNow } from "@/hooks/useNow";
import { BackingPanel } from "@/components/app/BackingPanel";
import { PendingWithdrawalBanner } from "@/components/app/PendingWithdrawalBanner";
import { SwapPanel } from "@/components/app/SwapPanel";
import { activeChain } from "@/lib/chain";
import { shortAddress, formatBackingPerToken } from "@/lib/format";
import { loadMeta } from "@/lib/metadata";

// Token detail — the shareable unit, keyed by the TOKEN address. The treasury is
// resolved on-chain from token.treasury().
export default function TokenDetailPage() {
  const params = useParams();
  const raw = typeof params.address === "string" ? params.address : "";
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(raw);
  const token = isAddr ? (raw as Address) : undefined;

  const now = useNow();
  const meta = useMemo(() => (token ? loadMeta(token) : undefined), [token]);
  const {
    treasury,
    backing,
    symbol,
    name,
    pending,
    marketPriceUsd,
    hasPool,
    graduated,
    isConfigured,
    isLoading,
    found,
  } = useBacking(token);

  if (!isAddr) return <Notice title="Invalid address" body="This page needs a valid token address." />;
  if (!isConfigured) {
    return <Notice title="Not configured" body="BackingLens isn't set. Deploy the core contracts and set NEXT_PUBLIC_LENS_ADDRESS." />;
  }
  if (isLoading) return <div className="card h-40 animate-pulse" />;
  if (!found || !treasury) {
    return <Notice title="Nothing here" body="No BALLAST token found at this address on the active chain." />;
  }

  // Market price vs backing — both in USD. Ratio only when a pool exists.
  const ratio =
    marketPriceUsd !== undefined && backing && backing.backingPerToken > 0n
      ? Number((marketPriceUsd * 10n ** 18n) / backing.backingPerToken) / 1e18
      : null;

  return (
    <div className="space-y-4">
      {pending && <PendingWithdrawalBanner pending={pending} now={now} />}

      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold text-text-primary">{symbol ?? shortAddress(token!)}</h1>
          <p className="truncate text-sm text-text-muted">{name ?? "Unnamed project"}</p>
          {meta?.category && <span className="mt-1 inline-block rounded-full bg-card px-2 py-0.5 text-xs text-text-muted">{meta.category}</span>}
        </div>
        <div className="text-right">
          <div className="figure-primary text-2xl">
            {marketPriceUsd !== undefined ? formatBackingPerToken(marketPriceUsd) : "—"}
          </div>
          <div className="metric-secondary">{hasPool ? "market price" : graduated ? "no liquidity" : "not launched"}</div>
          {ratio !== null && (
            <div className={`mt-0.5 text-xs ${ratio >= 1 ? "text-green" : "text-warning"}`}>
              {ratio.toFixed(2)}× backing
            </div>
          )}
        </div>
      </header>

      {meta?.description && <p className="text-sm text-text-secondary">{meta.description}</p>}

      {backing && <BackingPanel backing={backing} symbol={symbol ?? ""} now={now} />}

      {/* Launch-liquidity disclosure — verbatim approved copy. */}
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-text-primary">
          No protocol liquidity below backing at launch — not a floor
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          A ballasted launch seeds the project&apos;s tokens from its backing price upward, and nothing below it. So at
          the very first trades the token cannot print below its backing in this pool — not because the price is
          supported, but because no one has placed a bid there yet. The protocol spends nothing to hold the price and
          never will. Anyone can add liquidity below backing at any time, and once they do, the token can and will trade
          below its backing. Do not read the launch state as a floor.
        </p>
      </section>

      {/* Buy / Sell — pinned within thumb reach. */}
      <div className="sticky bottom-20">
        <SwapPanel token={token!} symbol={symbol ?? "TOKEN"} hasPool={hasPool} />
      </div>

      <a
        href={`${activeChain.blockExplorers.default.url}/address/${treasury}`}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-text-faint hover:text-text-secondary"
      >
        Verify this treasury on-chain ↗
      </a>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <h1 className="font-semibold text-text-primary">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}
