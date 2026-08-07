"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useDenylistEntry } from "@/hooks/useDenylist";
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
import { LiquidityDepthNote } from "@/components/app/LiquidityDepthNote";
import { ProjectLinks } from "@/components/app/ProjectLinks";
import { MotionSection } from "@/components/app/MotionSection";
import { Freshness } from "@/components/app/Freshness";
import { Meander } from "@/components/Meander";
import { activeChain } from "@/lib/chain";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress, formatBackingPerToken } from "@/lib/format";
import { formatSmallUsd, marketCapSupply } from "@/lib/market";
import { cn } from "@/lib/cn";

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
    depthToDoubleUsd,
    graduated,
    ownerFactory,
    isConfigured,
    isLoading,
    found,
  } = useBacking(token);
  const { meta } = useProjectMeta(metadataURI);
  const { market } = useMarket(token);
  const { holders } = useHolders(token);
  // Metadata denylist: a denied token keeps its ticker, price, backing, holders and
  // trades, but its project-supplied branding (name, logo, description, links) is
  // withheld and replaced by a notice stating why, with the raw metadataURI so
  // anyone can read what we withheld. Default-allow — undenied unless listed.
  const { denied: metaDenied, reason: denyReason } = useDenylistEntry(token);
  const shownMeta = metaDenied ? undefined : meta;

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
      {pending && <PendingWithdrawalBanner pending={pending} now={now} />}

      {/* Half-launched: pool never seeded — offer to finish it (permissionless
          graduate). Suppressed if ANY source shows a live pool. */}
      {!graduated && !hasPool && marketPriceUsd === undefined && market?.priceUsd === undefined && (
        <ResumeLaunchPanel token={token!} symbol={symbol} factory={ownerFactory} />
      )}

      {/* ── Header ─────────────────────────────────────────────────── */}
      <MotionSection>
        <header className="card p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Logo src={ipfsToGateway(shownMeta?.logo)} symbol={symbol} size={48} />
              <div className="min-w-0">
                <h1 className="truncate font-serif text-2xl font-semibold text-bone">{symbol ?? shortAddress(token!)}</h1>
                <p className="truncate text-sm text-text-muted">
                  {metaDenied ? <span className="italic text-text-faint">Metadata withheld</span> : (name ?? "Unnamed project")}
                </p>
                {/* Entry point to the dense trading terminal for this token — the
                    terminal is per-token, so it's reached from here, not the global nav. */}
                <Link
                  href={`/app/terminal/${token}`}
                  className="mt-1 inline-flex items-center gap-1 text-xs text-green underline underline-offset-2"
                >
                  Open in terminal ↗
                </Link>
              </div>
            </div>
            <div className="flex flex-col items-end">
              {/* Chain price governs; GeckoTerminal is the labelled fallback. */}
              <div className="figure-primary text-2xl">
                {(() => {
                  const v =
                    marketPriceUsd !== undefined
                      ? formatBackingPerToken(marketPriceUsd)
                      : market?.priceUsd !== undefined
                        ? formatSmallUsd(market.priceUsd)
                        : "—";
                  return <span key={v} className="anim-fade inline-block">{v}</span>;
                })()}
              </div>
              <div className="mt-0.5">
                {marketPriceUsd !== undefined ? (
                  <Freshness updatedAt={now} source="on-chain" />
                ) : market?.priceUsd !== undefined ? (
                  <Freshness updatedAt={market.fetchedAt} source="GeckoTerminal" />
                ) : (
                  <span className="metric-secondary">{graduated ? "no market yet" : "not launched"}</span>
                )}
              </div>
              {ratio !== null && (
                <div className={`mt-0.5 text-xs ${ratio >= 1 ? "text-green" : "text-warning"}`}>
                  {ratio.toFixed(2)}× backing
                </div>
              )}
            </div>
          </div>

          {/* Withheld (shownMeta undefined) for a denylisted token. */}
          <ProjectLinks meta={shownMeta} variant="row" className="mt-3" />

          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            {shownMeta?.category && <Badge>{shownMeta.category}</Badge>}
            <Badge>{activeChain.name}</Badge>
            <CopyAddress address={token!} label="Token contract" />
            {market?.change24hPct != null && (
              <span className={cn("tabular-nums", market.change24hPct >= 0 ? "text-positive" : "text-negative")}>
                {market.change24hPct >= 0 ? "+" : ""}
                {market.change24hPct.toFixed(2)}% 24h
              </span>
            )}
          </div>
          <LiquidityDepthNote depthToDoubleUsd={depthToDoubleUsd} className="mt-2" />
        </header>
      </MotionSection>

      {/* Metadata withheld — this token is on the owner-managed denylist. Ticker,
          price, backing, holders and trades stay; only project-supplied branding is
          withheld, with the reason + the raw metadataURI so anyone can verify. */}
      {metaDenied && (
        <section className="card border-warning-border bg-warning-bg p-5" role="note">
          <h2 className="font-serif text-lg font-semibold text-bone">Project metadata withheld</h2>
          <div className="mt-2 space-y-2 text-sm text-text-secondary">
            <p>
              BALLAST is not rendering this project&apos;s self-declared name, logo, description, or links.
              {denyReason ? <> Reason: <span className="text-text-primary">{denyReason}</span>.</> : null} The token is
              otherwise untouched — its price, backing, holders and trades are shown as normal, and nothing on-chain has
              changed. See our <a className="text-green underline underline-offset-2" href="/docs/content-policy">content policy</a> for
              what this is and is not used for.
            </p>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-faint">
              {ipfsToGateway(metadataURI) && (
                <a className="underline underline-offset-2 hover:text-text-secondary" href={ipfsToGateway(metadataURI)} target="_blank" rel="noopener noreferrer nofollow">
                  Read the raw metadata yourself ↗
                </a>
              )}
              <a
                className="underline underline-offset-2 hover:text-text-secondary"
                href={`${activeChain.blockExplorers.default.url}/token/${token}`}
                target="_blank"
                rel="noreferrer"
              >
                Token contract on Blockscout ↗
              </a>
            </p>
          </div>
        </section>
      )}

      <ProtocolTokenNotice token={token} />

      {/* Verified backing — the differentiator, full width above the split. */}
      {backing && (
        <MotionSection>
          <BackingPanel backing={backing} symbol={symbol ?? ""} now={now} />
        </MotionSection>
      )}

      {/* Two-column trade layout: chart + info on the left, a sticky trade rail
          (swap, then creator fees) on the right — the pro-launchpad pattern. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="min-w-0 space-y-4">
          <MotionSection>
            <MarketPanel token={token!} symbol={symbol} chainPriceUsd={marketPriceUsd} />
          </MotionSection>

          {shownMeta?.description && (
            <MotionSection>
              <section className="card p-5">
                <h2 className="section-label">About</h2>
                <p className="mt-2 text-sm text-text-secondary">{shownMeta.description}</p>
              </section>
            </MotionSection>
          )}

          <MotionSection>
            <MarketOverview
              marketPriceUsd={marketPriceUsd}
              totalSupply={marketCapSupply(backing?.totalSupply, totalSupply)}
              hasPool={hasPool}
              liquidityUsd={market?.top?.reserveUsd}
              volume24hUsd={market?.volume24hUsd}
              holdersCount={holders?.holdersCount}
            />
          </MotionSection>

          <MotionSection>
            <HoldersPanel token={token!} creator={creator} treasury={treasury} now={now} />
          </MotionSection>

          <MotionSection>
            <TradesPanel token={token!} symbol={symbol} now={now} />
          </MotionSection>

          <AllocationSlot />

          <MotionSection>
            <MetadataHistory launchUri={launchMetadataURI} currentUri={metadataURI} changed={metadataChanged} />
          </MotionSection>

          <MotionSection>
            <CreatorTrackRecord creator={creator} thisToken={token!} />
          </MotionSection>

          {/* Launch-liquidity disclosure — verbatim approved copy. */}
          <MotionSection>
            <section className="card p-4">
              <h2 className="text-sm font-semibold text-text-primary">No protocol liquidity below backing at launch — not a floor</h2>
              <p className="mt-2 text-sm text-text-secondary">
                A ballasted launch seeds the project&apos;s tokens from its backing price upward, and nothing below it. So
                at the very first trades the token cannot print below its backing in this pool — not because the price is
                supported, but because no one has placed a bid there yet. The protocol spends nothing to hold the price and
                never will. Anyone can add liquidity below backing at any time, and once they do, the token can and will
                trade below its backing. Do not read the launch state as a floor.
              </p>
            </section>
          </MotionSection>
        </div>

        {/* Sticky trade rail */}
        <div className="space-y-4 lg:sticky lg:top-20">
          <MotionSection>
            <SwapPanel token={token!} symbol={symbol ?? "TOKEN"} hasPool={hasPool} spotPriceWeth={marketPriceWeth} />
          </MotionSection>
          {creator && (
            <MotionSection>
              <FeePanel requireAccount={creator} alwaysShow />
            </MotionSection>
          )}
        </div>
      </div>

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
