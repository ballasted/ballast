"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useMarket } from "@/hooks/useMarket";
import { useNow } from "@/hooks/useNow";
import { BackingPanel } from "@/components/app/BackingPanel";
import { ResumeLaunchPanel } from "@/components/app/ResumeLaunchPanel";
import { MarketPanel } from "@/components/app/token/MarketPanel";
import { ProtocolTokenNotice } from "@/components/app/token/ProtocolTokenNotice";
import { PendingWithdrawalBanner } from "@/components/app/PendingWithdrawalBanner";
import { SwapPanel } from "@/components/app/SwapPanel";
import { FeePanel } from "@/components/app/FeePanel";
import {
  MarketOverview,
  AllocationSlot,
  MetadataHistory,
  CreatorTrackRecord,
  HoldersPanel,
  TradesPanel,
} from "@/components/app/token/TokenSections";
import { useHolders } from "@/hooks/useHolders";
import { Logo } from "@/components/app/Logo";
import { Meander } from "@/components/Meander";
import { activeChain } from "@/lib/chain";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress, formatBackingPerToken } from "@/lib/format";
import { formatSmallUsd } from "@/lib/market";

// Token detail — the shareable unit, keyed by the TOKEN address. The treasury is
// resolved on-chain from token.treasury(). Everything that can be sourced from
// chain state is shown live; anything that needs the indexer (24h change, chart,
// holders, trades, volume) carries an honest label until Phase 3.
export default function TokenDetailPage() {
  const params = useParams();
  const raw = typeof params.address === "string" ? params.address : "";
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(raw);
  const token = isAddr ? (raw as Address) : undefined;

  const now = useNow();
  const {
    treasury,
    backing,
    symbol,
    name,
    metadataURI,
    launchMetadataURI,
    metadataChanged,
    creator,
    totalSupply,
    pending,
    marketPriceUsd,
    marketPriceWeth,
    hasPool,
    graduated,
    isConfigured,
    isLoading,
    found,
  } = useBacking(token);
  const { meta } = useProjectMeta(metadataURI);
  const { market } = useMarket(token);
  const { holders } = useHolders(token);

  if (!isAddr) return <Notice title="Invalid address" body="This page needs a valid token address." />;
  if (!isConfigured) {
    return <Notice title="Not configured" body="BackingLens isn't set. Deploy the core contracts and set NEXT_PUBLIC_LENS_ADDRESS." />;
  }
  if (isLoading) return <TokenSkeleton />;
  if (!found || !treasury) {
    return <Notice title="Nothing here" body="No BALLAST token found at this address on the active chain." />;
  }

  const ratio =
    marketPriceUsd !== undefined && backing && backing.backingPerToken > 0n
      ? Number((marketPriceUsd * 10n ** 18n) / backing.backingPerToken) / 1e18
      : null;

  return (
    <div className="space-y-4">
      {/* Pending withdrawal — above everything when active (spec 5). */}
      {pending && <PendingWithdrawalBanner pending={pending} now={now} />}

      {/* Half-launched: token exists but pool never seeded. Offer to finish it
          (permissionless graduate) rather than leaving a dead token (Part B). */}
      {!graduated && <ResumeLaunchPanel token={token!} symbol={symbol} />}

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Logo src={ipfsToGateway(meta?.logo)} symbol={symbol} size={48} />
            <div className="min-w-0">
              <h1 className="truncate font-serif text-2xl font-semibold text-bone">{symbol ?? shortAddress(token!)}</h1>
              <p className="truncate text-sm text-text-muted">{name ?? "Unnamed project"}</p>
            </div>
          </div>
          <div className="text-right">
            {/* Chain price wins when available (on-chain StateView); otherwise fall
                back to GeckoTerminal, clearly labelled. Never a fabricated figure. */}
            <div className="figure-primary text-2xl">
              {(() => {
                const v =
                  marketPriceUsd !== undefined
                    ? formatBackingPerToken(marketPriceUsd)
                    : market?.priceUsd !== undefined
                      ? formatSmallUsd(market.priceUsd)
                      : "—";
                // Crossfade the price on change; never count it up.
                return <span key={v} className="anim-fade inline-block">{v}</span>;
              })()}
            </div>
            <div className="metric-secondary">
              {marketPriceUsd !== undefined
                ? "market price · on-chain"
                : market?.priceUsd !== undefined
                  ? "market price · GeckoTerminal"
                  : graduated
                    ? "no market yet"
                    : "not launched"}
            </div>
            {ratio !== null && (
              <div className={`mt-0.5 text-xs ${ratio >= 1 ? "text-green" : "text-warning"}`}>{ratio.toFixed(2)}× backing</div>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          {meta?.category && <Badge>{meta.category}</Badge>}
          <Badge>{activeChain.name}</Badge>
          <CopyAddress address={token!} label="Token contract" />
          {meta?.x && <ExtLink href={toUrl(meta.x)}>X ↗</ExtLink>}
          {meta?.telegram && <ExtLink href={toUrl(meta.telegram)}>Telegram ↗</ExtLink>}
          {meta?.website && <ExtLink href={toUrl(meta.website)}>Website ↗</ExtLink>}
        </div>
        {/* 24h change from GeckoTerminal when available, labelled with source;
            otherwise say plainly it needs a market source — never a fabricated %. */}
        <div className="mt-2 text-xs">
          {market?.change24hPct != null ? (
            <span className={market.change24hPct >= 0 ? "text-positive" : "text-negative"}>
              {market.change24hPct >= 0 ? "+" : ""}
              {market.change24hPct.toFixed(2)}% 24h{" "}
              <span className="text-text-faint">· GeckoTerminal</span>
            </span>
          ) : (
            <span className="text-text-faint">24h change: no market source yet</span>
          )}
        </div>
      </header>

      {/* $BALLAST-only: it shares the platform name and routes creator fees to the
          protocol vault, so a permanent "not a protocol token" notice sits here,
          above the fold, right under the name (see ProtocolTokenNotice). */}
      <ProtocolTokenNotice token={token} />

      {/* Verified backing — above the chart, the reason the page exists. */}
      {backing && <BackingPanel backing={backing} symbol={symbol ?? ""} now={now} />}

      {/* Market — price, 24h volume/change, chart embed and venues from
          GeckoTerminal, clearly sourced; chain price governs when available. An
          un-indexed token shows an honest empty state, never a flat line at zero. */}
      <MarketPanel token={token!} symbol={symbol} chainPriceUsd={marketPriceUsd} />

      {/* Swap */}
      <SwapPanel token={token!} symbol={symbol ?? "TOKEN"} hasPool={hasPool} spotPriceWeth={marketPriceWeth} />

      {/* Creator fees — only the creator sees this, shown even at zero so they know
          where fees land. The balance is the creator's aggregate across all their
          launches (owed is per-recipient), so one claim sweeps everything. */}
      {creator && <FeePanel requireAccount={creator} alwaysShow />}

      {/* About */}
      {meta?.description && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">About</h2>
          <p className="mt-2 text-sm text-text-secondary">{meta.description}</p>
        </section>
      )}

      <MarketOverview
        marketPriceUsd={marketPriceUsd}
        totalSupply={totalSupply ?? backing?.totalSupply}
        hasPool={hasPool}
        liquidityUsd={market?.top?.reserveUsd}
        volume24hUsd={market?.volume24hUsd}
        holdersCount={holders?.holdersCount}
      />

      <HoldersPanel token={token!} creator={creator} treasury={treasury} now={now} />

      <TradesPanel token={token!} symbol={symbol} now={now} />

      <AllocationSlot />

      <MetadataHistory launchUri={launchMetadataURI} currentUri={metadataURI} changed={metadataChanged} />

      <CreatorTrackRecord creator={creator} thisToken={token!} />

      {/* Launch-liquidity disclosure — verbatim approved copy. */}
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-text-primary">No protocol liquidity below backing at launch — not a floor</h2>
        <p className="mt-2 text-sm text-text-secondary">
          A ballasted launch seeds the project&apos;s tokens from its backing price upward, and nothing below it. So at
          the very first trades the token cannot print below its backing in this pool — not because the price is
          supported, but because no one has placed a bid there yet. The protocol spends nothing to hold the price and
          never will. Anyone can add liquidity below backing at any time, and once they do, the token can and will trade
          below its backing. Do not read the launch state as a floor.
        </p>
      </section>

      <Meander className="opacity-60" />

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

function CopyAddress({ address, label }: { address: Address; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-text-secondary transition-colors hover:border-text-faint"
      title={`Copy ${label ? label.toLowerCase() : "contract"} address ${address}`}
    >
      {label && <span className="text-text-faint">{label}</span>}
      <span className="font-mono">{copied ? "Copied ✓" : shortAddress(address)}</span>
      {!copied && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className="text-text-faint">
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-border px-2.5 py-1 text-text-secondary">{children}</span>;
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-full border border-border px-2.5 py-1 text-text-secondary transition-colors hover:border-text-faint">
      {children}
    </a>
  );
}

// Metadata stores handles like "x.com/name" / "t.me/name" — normalise to a URL.
function toUrl(v: string): string {
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `https://${v.replace(/^\/+/, "")}`;
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h1 className="font-serif font-semibold text-bone">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}

// Loading skeleton shaped like the real token page — header card (logo, name,
// price) above the accent-bordered backing panel — so the layout doesn't jump
// when the chain reads land (Phase 3).
function TokenSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 animate-pulse rounded-full bg-surface-raised" />
            <div className="space-y-2">
              <div className="h-6 w-24 animate-pulse rounded bg-surface-raised" />
              <div className="h-3 w-36 animate-pulse rounded bg-surface-raised" />
            </div>
          </div>
          <div className="h-7 w-20 animate-pulse rounded bg-surface-raised" />
        </div>
        <div className="mt-4 flex gap-2">
          <div className="h-5 w-16 animate-pulse rounded bg-surface-raised" />
          <div className="h-5 w-24 animate-pulse rounded bg-surface-raised" />
        </div>
      </div>
      <div className="card border-accent p-5">
        <div className="h-3 w-28 animate-pulse rounded bg-surface-raised" />
        <div className="mt-3 h-9 w-40 animate-pulse rounded bg-surface-raised" />
        <div className="mt-4 h-2.5 w-full animate-pulse rounded-full bg-surface-raised" />
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="h-12 animate-pulse rounded bg-surface-raised" />
          <div className="h-12 animate-pulse rounded bg-surface-raised" />
        </div>
      </div>
    </div>
  );
}
