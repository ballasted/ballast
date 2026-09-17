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
  AllocationSlot,
  MetadataHistory,
  CreatorTrackRecord,
  HoldersPanel,
  TradesPanel,
} from "@/components/app/token/TokenSections";
import { cn } from "@/lib/cn";
import { TokenStatRow } from "@/components/app/token/TokenStatRow";
import { TerminalChart } from "@/components/app/terminal/TerminalChart";
import { useOhlcv } from "@/hooks/useOhlcv";
import { DEFAULT_TIMEFRAME, type Timeframe } from "@/lib/market";
import { useHolders } from "@/hooks/useHolders";
import { AssetDisc } from "@/components/app/AssetDisc";
import { VerificationPanel } from "@/components/app/VerificationPanel";
import { LiquidityDepthNote } from "@/components/app/LiquidityDepthNote";
import { ProjectLinks } from "@/components/app/ProjectLinks";
import { MotionSection } from "@/components/app/MotionSection";
import { Meander } from "@/components/Meander";
import { activeChain } from "@/lib/chain";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress } from "@/lib/format";

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
  const [tf, setTf] = useState<Timeframe>(DEFAULT_TIMEFRAME);
  // One card, tab-switched, instead of four/two stacked always-visible cards —
  // matches the sparse EON token-page pattern (a single Recent-trades/Holders
  // tab card, not a wall of separate sections) without touching the panels'
  // own internals, which TerminalTabs.tsx also reuses as-is.
  const [activityTab, setActivityTab] = useState<"trades" | "holders">("trades");
  const [infoTab, setInfoTab] = useState<"verification" | "supply" | "history" | "creator">("verification");
  const { ohlcv, isLoading: ohlcvLoading, available: ohlcvAvailable } = useOhlcv(token, tf);
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

  const ballasted = Boolean(backing && backing.totalValueUsd > 0n);

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
              <AssetDisc src={ipfsToGateway(shownMeta?.logo)} symbol={symbol} size={48} />
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
          </div>

          {/* Withheld (shownMeta undefined) for a denylisted token. */}
          <ProjectLinks meta={shownMeta} variant="row" className="mt-3" />

          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            {shownMeta?.category && <Badge>{shownMeta.category}</Badge>}
            <Badge>{activeChain.name}</Badge>
            <CopyAddress address={token!} label="Token contract" />
          </div>
          <LiquidityDepthNote depthToDoubleUsd={depthToDoubleUsd} className="mt-2" />
        </header>
      </MotionSection>

      {/* Stat row above the fold — price, backing beside it, and the market figures,
          each with its source + age (spec: pools.trade anchoring row, our figures). */}
      <MotionSection>
        <TokenStatRow
          priceUsd1e18={marketPriceUsd}
          priceFallbackNum={market?.priceUsd}
          ballasted={ballasted}
          backingPerToken1e18={backing?.backingPerToken}
          change24hPct={market?.change24hPct}
          volume24hUsd={market?.volume24hUsd}
          liquidityUsd={market?.top?.reserveUsd}
          holdersCount={holders?.holdersCount}
          now={now}
          marketFetchedAt={market?.fetchedAt}
        />
      </MotionSection>

      {/* Metadata withheld — this token is on the owner-managed denylist. Ticker,
          price, backing, holders and trades stay; only project-supplied branding is
          withheld, with the reason + the raw metadataURI so anyone can verify. */}
      {metaDenied && (
        <section className="card border-warning-border bg-warning-bg p-5" role="note">
          <h2 className="font-serif text-lg font-semibold text-bone">Metadata withheld</h2>
          <div className="mt-2 space-y-2 text-sm text-text-secondary">
            <p>
              Name, logo, description, and links are withheld{denyReason ? <> — <span className="text-text-primary">{denyReason}</span></> : null}.
              Price, backing, holders, and trades are unaffected.{" "}
              <a className="text-green underline underline-offset-2" href="/docs/content-policy">Content policy</a>.
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
          {/* Native candlestick (reused from the terminal) — replaces the off-palette
              GeckoTerminal iframe. Chart left, swap sticky on the right. */}
          <MotionSection>
            <TerminalChart
              candles={ohlcv?.candles ?? []}
              timeframe={tf}
              onTimeframe={setTf}
              source={ohlcv?.source ?? "GeckoTerminal"}
              fetchedAt={ohlcv?.fetchedAt}
              loading={ohlcvLoading}
              available={ohlcvAvailable}
            />
          </MotionSection>

          {shownMeta?.description && (
            <MotionSection>
              <section className="card p-5">
                <h2 className="section-label">About</h2>
                <p className="mt-2 text-sm text-text-secondary">{shownMeta.description}</p>
              </section>
            </MotionSection>
          )}

          {/* Recent trades / Holders — ONE card, tab-switched (EON's pattern), not
              two always-stacked cards. Both panels already render their own
              self-contained <section>, so switching which one mounts is enough —
              no change to either component (TerminalTabs.tsx reuses them the same
              way, one at a time). */}
          <MotionSection>
            <TabBar
              tabs={[
                { id: "trades", label: "Recent trades" },
                { id: "holders", label: "Holders" },
              ]}
              active={activityTab}
              onChange={setActivityTab}
            />
            {activityTab === "trades" ? (
              <TradesPanel token={token!} symbol={symbol} now={now} />
            ) : (
              <HoldersPanel token={token!} creator={creator} treasury={treasury} now={now} />
            )}
          </MotionSection>

          <MotionSection>
            <MarketPanel token={token!} chainPriceUsd={marketPriceUsd} />
          </MotionSection>

          {/* Verification / Supply / History / Creator — ONE card, tab-switched,
              instead of four always-visible stacked cards. Same technique as
              above: each panel is already self-contained, only one mounts. */}
          <MotionSection>
            <TabBar
              tabs={[
                { id: "verification", label: "Verification" },
                { id: "supply", label: "Supply" },
                { id: "history", label: "History" },
                { id: "creator", label: "Creator" },
              ]}
              active={infoTab}
              onChange={setInfoTab}
            />
            {infoTab === "verification" ? (
              <VerificationPanel token={token} />
            ) : infoTab === "supply" ? (
              <AllocationSlot />
            ) : infoTab === "history" ? (
              <MetadataHistory launchUri={launchMetadataURI} currentUri={metadataURI} changed={metadataChanged} />
            ) : (
              <CreatorTrackRecord creator={creator} thisToken={token!} />
            )}
          </MotionSection>

          {/* Launch-liquidity disclosure — approved substance, tightened wording. */}
          <MotionSection>
            <section className="card p-4">
              <h2 className="text-sm font-semibold text-text-primary">Not a floor</h2>
              <p className="mt-2 text-sm text-text-secondary">
                A ballasted launch seeds liquidity from backing price upward, nothing below — not price support, just no
                bid placed there yet. Anyone can add liquidity below backing later, and once they do, the token can and
                will trade below it.
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
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-text-secondary transition-colors hover:border-text-faint md:min-h-0"
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

// Small tab-pill row used to collapse several always-visible cards into one
// tab-switched card (EON's sparse token-page pattern) without changing any of
// the panels themselves — only one mounts at a time.
function TabBar<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="mb-3 flex gap-2 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          aria-pressed={active === t.id}
          className={cn("tab shrink-0", active === t.id ? "tab-active" : "tab-idle")}
        >
          {t.label}
        </button>
      ))}
    </div>
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
