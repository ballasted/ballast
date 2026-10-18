"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { useProjects } from "@/hooks/useProjects";
import { useAllBaskets } from "@/hooks/useAllBaskets";
import { useAssets } from "@/hooks/useAssets";
import { AssetDisc } from "@/components/app/AssetDisc";
import { MotionSection } from "@/components/app/MotionSection";
import { shortAddress } from "@/lib/format";
import { isBasketConfigured, isHiddenToken, isRetiredToken, WETH_ADDRESS } from "@/lib/contracts";
import type { BasketSwap } from "@/hooks/useBasketHistory";

// Public baskets directory — explains what a stock basket is in one line and
// lists every launch whose creator has funded one. Read-only for everyone:
// deposit/"Add basket" controls live on a launch's own backing page, gated to
// its gen-4 creator (see /app/backing/[address]). No wallet required here.
export default function BasketsPage() {
  const { byToken, status } = useAllBaskets();
  const { projects } = useProjects();
  const { assets } = useAssets();

  const symbolByAddress = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assets) if (a.symbol) m.set(a.address.toLowerCase(), a.symbol);
    if (WETH_ADDRESS) m.set(WETH_ADDRESS.toLowerCase(), "WETH");
    return m;
  }, [assets]);

  const rows = useMemo(() => {
    const out: { token: Address; symbol?: string; name?: string; latest: BasketSwap }[] = [];
    for (const [token, swaps] of byToken) {
      if (swaps.length === 0) continue;
      if (isRetiredToken(token as Address) || isHiddenToken(token as Address)) continue;
      const latest = [...swaps].sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1))[0]!;
      const p = projects.find((x) => x.token.toLowerCase() === token);
      out.push({ token: (p?.token ?? (token as Address)) as Address, symbol: p?.symbol, name: p?.name, latest });
    }
    return out;
  }, [byToken, projects]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Baskets</h1>
        <p className="mt-1 max-w-xl text-sm text-text-muted">
          A basket swaps ETH into several tokenized stocks in one transaction, forwarded to the creator to deposit into
          their treasury.{" "}
          <Link href="/docs" className="underline underline-offset-2 hover:text-text-secondary">
            Docs
          </Link>
        </p>
      </div>

      {!isBasketConfigured ? (
        <div className="card p-6 text-center text-sm text-text-muted">Baskets aren&apos;t available on this deployment.</div>
      ) : status === "loading" || status === "idle" ? (
        <SkeletonGrid />
      ) : status === "failed" ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">Couldn&apos;t load basket history.</p>
          <button className="btn-secondary mt-4" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-6 text-center text-sm text-text-muted">No launch holds a basket yet.</div>
      ) : (
        <>
          {status === "partial" && (
            <p className="text-xs text-warning">History may be incomplete — the RPC only returned part of the scan.</p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {rows.map((r) => (
              <MotionSection key={r.token}>
                <BasketCard row={r} symbolByAddress={symbolByAddress} />
              </MotionSection>
            ))}
          </div>
        </>
      )}

      <p className="rounded-input bg-card px-3 py-2 text-xs text-text-muted">
        Holding a token gives no claim, redemption right, or entitlement to treasury assets.
      </p>
    </div>
  );
}

function BasketCard({
  row,
  symbolByAddress,
}: {
  row: { token: Address; symbol?: string; name?: string; latest: BasketSwap };
  symbolByAddress: Map<string, string>;
}) {
  const { token, symbol, name, latest } = row;
  return (
    <Link href={`/app/backing/${token}`} className="card card-hover flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <AssetDisc symbol={symbol} size={40} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-text-primary">{symbol ?? shortAddress(token)}</div>
          <div className="truncate text-sm text-text-muted">{name ?? shortAddress(token)}</div>
        </div>
      </div>

      <div>
        <div className="eyebrow">Composition</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {latest.legs.map((leg) => (
            <span key={leg.asset} className="chip chip-neutral tabular-nums">
              {leg.weightBps / 100}% {symbolByAddress.get(leg.asset.toLowerCase()) ?? shortAddress(leg.asset)}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card h-36 animate-pulse p-4" />
      ))}
    </div>
  );
}
