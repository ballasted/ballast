"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useNow } from "@/hooks/useNow";
import { BackingPanel } from "@/components/app/BackingPanel";
import { PendingWithdrawalBanner } from "@/components/app/PendingWithdrawalBanner";
import { SwapPanel } from "@/components/app/SwapPanel";
import {
  MarketOverview,
  AllocationSlot,
  MetadataHistory,
  CreatorTrackRecord,
  PendingDataPanel,
} from "@/components/app/token/TokenSections";
import { Logo } from "@/components/app/Logo";
import { Meander } from "@/components/Meander";
import { activeChain } from "@/lib/chain";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress, formatBackingPerToken } from "@/lib/format";

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
            <div className="figure-primary text-2xl">
              {marketPriceUsd !== undefined ? formatBackingPerToken(marketPriceUsd) : "—"}
            </div>
            <div className="metric-secondary">{hasPool ? "market price" : graduated ? "no liquidity" : "not launched"}</div>
            {ratio !== null && (
              <div className={`mt-0.5 text-xs ${ratio >= 1 ? "text-green" : "text-warning"}`}>{ratio.toFixed(2)}× backing</div>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          {meta?.category && <Badge>{meta.category}</Badge>}
          <Badge>{activeChain.name}</Badge>
          <CopyAddress address={token!} />
          {meta?.x && <ExtLink href={toUrl(meta.x)}>X ↗</ExtLink>}
          {meta?.telegram && <ExtLink href={toUrl(meta.telegram)}>Telegram ↗</ExtLink>}
          {meta?.website && <ExtLink href={toUrl(meta.website)}>Website ↗</ExtLink>}
        </div>
        {/* 24h change needs the indexer — labelled, never a fabricated %. */}
        <div className="mt-2 text-xs text-text-faint">24h change: needs indexer</div>
      </header>

      {/* Verified backing — above the chart, the reason the page exists. */}
      {backing && <BackingPanel backing={backing} symbol={symbol ?? ""} now={now} />}

      {/* Price chart — pending the indexer / GeckoTerminal embed (Phase 3). A token
          with no trades shows an honest empty state, never a flat line at zero. */}
      <PendingDataPanel
        title="Price chart"
        what="The price chart activates once the pool has trades and the indexer is wired. It is never drawn as a flat line at zero when there's nothing to show."
      />

      {/* Swap */}
      <SwapPanel token={token!} symbol={symbol ?? "TOKEN"} hasPool={hasPool} spotPriceWeth={marketPriceWeth} />

      {/* About */}
      {meta?.description && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">About</h2>
          <p className="mt-2 text-sm text-text-secondary">{meta.description}</p>
        </section>
      )}

      <MarketOverview marketPriceUsd={marketPriceUsd} totalSupply={totalSupply ?? backing?.totalSupply} hasPool={hasPool} />

      <PendingDataPanel
        title="Holders"
        what="The holder list — with LP, treasury, and creator labelled — is built from Transfer events by the indexer, which isn't wired yet. Holder count will equal the length of this list."
      />
      <PendingDataPanel
        title="Recent trades"
        what="The trade feed comes from pool swap events via the indexer, which isn't wired yet. 24h volume is the sum of this feed over that window."
      />

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
      className="rounded-full border border-border px-2.5 py-1 font-mono text-text-secondary transition-colors hover:border-text-faint"
      title="Copy contract address"
    >
      {copied ? "Copied" : shortAddress(address)}
    </button>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-border px-2.5 py-1 text-text-secondary">{children}</span>;
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="rounded-full border border-border px-2.5 py-1 text-text-secondary transition-colors hover:border-text-faint">
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
