"use client";

import Link from "next/link";
import { KeelMark } from "@/components/Wordmark";
import { AssetDisc } from "@/components/app/AssetDisc";
import { useAssets } from "@/hooks/useAssets";
import { CURRENT_CAMPAIGN } from "@/lib/campaign";
import type { AssetIdentity } from "@/lib/assetIdentity";

// Discover hero (spec §5.1) — two cards, equal height. Left: the launch pitch,
// with a slow orbit of the REAL current reserve allowlist (useAssets — this
// product's allowlist is stocks/ETFs only, per the Milestone 1 decision; the
// spec's own example set (SGOV/NVDA/AAPL/SPY/ETH/USDC) mixes in assets that
// aren't actually live here). Right: a campaign slot from lib/campaign.ts, so
// it can change without touching this component.
export function DiscoverHero() {
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      <PrimaryCard />
      <CampaignCard />
    </div>
  );
}

function PrimaryCard() {
  const { assets } = useAssets();
  // Sourced directly from AssetRegistry (useAssets reads it live), so these
  // pairs are recognized BY CONSTRUCTION — no separate resolve needed, this
  // isn't an externally-claimed address being checked against the registry.
  const orbitAssets = assets
    .filter((a): a is typeof a & { symbol: string } => Boolean(a.symbol))
    .map((a) => ({ symbol: a.symbol, identity: { status: "recognized", symbol: a.symbol } as AssetIdentity }));
  const fallback = [{ symbol: "SGOV", identity: { status: "recognized", symbol: "SGOV" } as AssetIdentity }];
  const orbitItems = orbitAssets.length > 0 ? orbitAssets.slice(0, 6) : fallback;

  return (
    <div className="card relative overflow-hidden p-6 lg:p-8" style={{ boxShadow: "0 0 80px rgba(34,201,58,0.10)" }}>
      <div className="grid items-center gap-6 sm:grid-cols-[1fr_auto]">
        <div>
          <h1 className="font-serif text-display-sm text-text-primary">
            Launch on top of a real treasury.
          </h1>
          <p className="mt-3 max-w-sm text-sm text-text-secondary">
            Pair your token against tokenized real-world assets and let anyone verify the backing, live, on-chain.
          </p>
          <Link href="/app/create" className="btn-primary mt-5 inline-block px-6">
            Deploy now
          </Link>
        </div>

        <div className="relative mx-auto h-44 w-44 shrink-0 sm:h-52 sm:w-52 lg:h-64 lg:w-64" aria-hidden>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-raised lg:h-16 lg:w-16">
              <KeelMark size={26} />
            </div>
          </div>
          <div className="orbit-ring absolute inset-0">
            {orbitItems.map((item, i) => (
              <div
                key={item.symbol}
                className="absolute inset-0"
                style={{ transform: `rotate(${(360 / orbitItems.length) * i}deg)` }}
              >
                <div className="absolute left-1/2 top-0 -translate-x-1/2">
                  <div className="orbit-counter">
                    <AssetDisc symbol={item.symbol} size={36} identity={item.identity} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CampaignCard() {
  const c = CURRENT_CAMPAIGN;
  return (
    <div className="card flex flex-col justify-center p-6 lg:p-8">
      <span className="eyebrow">{c.eyebrow}</span>
      <h2 className="mt-2 font-serif text-display-sm text-text-primary">{c.headline}</h2>
      <p className="mt-3 max-w-sm text-sm text-text-secondary">{c.body}</p>
      <Link href={c.ctaHref} className="btn-secondary mt-5 inline-block w-fit px-6">
        {c.ctaLabel}
      </Link>
    </div>
  );
}
