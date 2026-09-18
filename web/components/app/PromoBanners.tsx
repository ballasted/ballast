"use client";

import Link from "next/link";
import { KeelMark } from "@/components/Wordmark";
import { AssetDisc } from "@/components/app/AssetDisc";
import { useAssets } from "@/hooks/useAssets";
import type { AssetIdentity } from "@/lib/assetIdentity";

// Two promo banners at the top of Discover — the "launchpad energy" entry
// point. Both stay inside the existing green/bone palette (no invented hue)
// and both point at real, existing surfaces: launching against a real
// treasury, and the buyback/burn tracker. Neither implies a return, a
// guarantee, or a benefit for holding/depositing (CLAUDE.md hard rules).
export function PromoBanners() {
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      <TreasuryBanner />
      <BuybackBanner />
    </div>
  );
}

function TreasuryBanner() {
  const { assets } = useAssets();
  const orbitAssets = assets
    .filter((a): a is typeof a & { symbol: string } => Boolean(a.symbol))
    .map((a) => ({ symbol: a.symbol, identity: { status: "recognized", symbol: a.symbol } as AssetIdentity }));
  const fallback = [{ symbol: "SGOV", identity: { status: "recognized", symbol: "SGOV" } as AssetIdentity }];
  const orbitItems = orbitAssets.length > 0 ? orbitAssets.slice(0, 6) : fallback;

  return (
    <div
      className="card relative overflow-hidden p-6 lg:p-8"
      style={{
        background: "radial-gradient(120% 140% at 88% 50%, rgba(34,201,58,0.22), transparent 60%), #0E1410",
      }}
    >
      <div className="grid items-center gap-6 sm:grid-cols-[1fr_auto]">
        <div className="relative z-10 max-w-sm">
          <p className="eyebrow">Launchpad</p>
          {/* The page's ONLY h1 — DiscoverHero (which used to hold it) was
              removed as a duplicate hero row; this is now the sole heading. */}
          <h1 className="mt-2 font-serif text-2xl font-semibold tracking-tight text-bone">
            Launch a token backed by a real, verifiable treasury.
          </h1>
          <Link href="/app/create" className="mt-5 inline-block rounded-button bg-bone px-6 py-3 font-semibold text-bg transition-transform hover:-translate-y-0.5">
            Launch now
          </Link>
        </div>

        <div className="relative mx-auto h-36 w-36 shrink-0 sm:h-40 sm:w-40" aria-hidden>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="live-dot absolute h-9 w-9 rounded-full bg-green/25" />
            <div className="core-pulse flex h-9 w-9 items-center justify-center rounded-full bg-surface-raised">
              <KeelMark size={18} />
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
                    <AssetDisc symbol={item.symbol} size={28} identity={item.identity} />
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

function BuybackBanner() {
  return (
    <div
      className="card relative overflow-hidden p-6 lg:p-8"
      style={{
        background: "radial-gradient(120% 140% at 88% 50%, rgba(232,163,61,0.18), transparent 60%), #0E1410",
      }}
    >
      <div className="relative z-10 flex h-full flex-col justify-center">
        <p className="eyebrow text-warning">Buyback & burn</p>
        <h2 className="mt-2 max-w-sm font-serif text-2xl font-semibold tracking-tight text-bone">
          Every burn is verifiable on-chain.
        </h2>
        <p className="mt-2 max-w-sm text-sm text-text-secondary">
          Track the burn address balance and history directly — no dashboard to trust, just the chain.
        </p>
        <Link href="/app/buyback" className="mt-5 inline-block w-fit rounded-button bg-bone px-6 py-3 font-semibold text-bg transition-transform hover:-translate-y-0.5">
          View the tracker
        </Link>
      </div>
      {/* Ghost numeral watermark — decorative only, echoes EON's stroke-only digits
          but with a real on-chain concept (the burn count / a flame glyph) instead
          of an invented leverage multiplier. */}
      <svg
        aria-hidden
        viewBox="0 0 200 200"
        className="pointer-events-none absolute -right-8 top-1/2 h-64 w-64 -translate-y-1/2 opacity-[0.13]"
      >
        <path
          d="M100 20c0 30-30 40-30 70a30 30 0 0060 0c0-15-10-20-10-35 10 10 20 25 20 45a40 40 0 01-80 0c0-45 40-55 40-80z"
          fill="none"
          stroke="#F5F3EC"
          strokeWidth="3"
        />
      </svg>
    </div>
  );
}
