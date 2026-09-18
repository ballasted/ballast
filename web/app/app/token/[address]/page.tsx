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
import { useAssets } from "@/hooks/useAssets";
import { resolveAssetIdentity } from "@/lib/assetIdentity";
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
import { activeChain } from "@/lib/chain";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress } from "@/lib/format";

type BackingAssetView = { asset: `0x${string}` };
type TabId = "trades" | "holders" | "backing" | "about";

// Token detail — the shareable unit, keyed by the TOKEN address. Header + stat
// strip + chart/trade side by side, nothing else above the fold; everything
// else lives behind the four tabs below (UI principles).
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
  const [tab, setTab] = useState<TabId>("trades");
  const { ohlcv, isLoading: ohlcvLoading, available: ohlcvAvailable } = useOhlcv(token, tf);
  // Metadata denylist: a denied token keeps its ticker, price, backing, holders and
  // trades, but its project-supplied branding (name, logo, description, links) is
  // withheld and replaced by a notice stating why, with the raw metadataURI so
  // anyone can read what we withheld. Default-allow — undenied unless listed.
  const { denied: metaDenied, reason: denyReason } = useDenylistEntry(token);
  const shownMeta = metaDenied ? undefined : meta;

  // Backing chip resolved by ADDRESS against the live AssetRegistry, same as
  // the Discover card (CLAUDE.md rule 14) — never by trusting a claimed ticker.
  const { assets: registry, isLoading: registryLoading } = useAssets();
  const ballasted = Boolean(backing && backing.totalValueUsd > 0n);
  const backingAsset = (backing?.assets as unknown as BackingAssetView[] | undefined)?.[0];
  const identity = resolveAssetIdentity(backingAsset?.asset, undefined, registry, !registryLoading);

  if (!isAddr) return <Notice title="Invalid address" body="This page needs a valid token address." />;
  if (!isConfigured) {
    return <Notice title="Not configured" body="BackingLens isn't set. Deploy the core contracts and set NEXT_PUBLIC_LENS_ADDRESS." />;
  }
  if (isLoading) return <TokenSkeleton />;
  if (!found || !treasury) {
    return <Notice title="Nothing here" body="No BALLAST token found at this address on the active chain." />;
  }

  return (
    <div className="space-y-4">
      {pending && <PendingWithdrawalBanner pending={pending} now={now} />}

      {/* Half-launched: pool never seeded — offer to finish it (permissionless
          graduate). Suppressed if ANY source shows a live pool. */}
      {!graduated && !hasPool && marketPriceUsd === undefined && market?.priceUsd === undefined && (
        <ResumeLaunchPanel token={token!} symbol={symbol} factory={ownerFactory} />
      )}

      {/* ── Header — avatar, $TICKER, name, CA + copy, backing chip, state pill. ── */}
      <MotionSection>
        <header className="card p-5">
          <div className="flex min-w-0 items-center gap-3">
            <AssetDisc src={ipfsToGateway(shownMeta?.logo)} symbol={symbol} size={48} />
            <div className="min-w-0">
              <h1 className="truncate font-serif text-2xl font-semibold text-bone">{symbol ?? shortAddress(token!)}</h1>
              <p className="truncate text-sm text-text-muted">{metaDenied ? "Metadata withheld" : (name ?? shortAddress(token!))}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <CopyAddress address={token!} label="Token contract" />
            {ballasted ? (
              <span className="chip chip-accent">
                Backed by <AssetDisc identity={identity} size={16} /> {identity.status === "recognized" ? identity.symbol : "…"}
              </span>
            ) : (
              <span className="chip chip-neutral">No treasury</span>
            )}
            <span className={cn("chip", hasPool ? "chip-accent" : "chip-neutral")}>{hasPool ? "Graduated" : "On curve"}</span>
            <LiquidityDepthNote depthToDoubleUsd={depthToDoubleUsd} />
            <Link
              href={`/app/terminal/${token}`}
              className="text-xs text-green underline underline-offset-2"
            >
              Terminal ↗
            </Link>
          </div>
        </header>
      </MotionSection>

      {/* ── Stat strip: price · backing/token · 24h · volume · liquidity · holders. ── */}
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

      {/* ── Chart + trade panel, side by side. Nothing else above the fold. ── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
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

      {/* ── Tabs: Trades · Holders · Backing · About. ── */}
      <MotionSection>
        <TabBar
          tabs={[
            { id: "trades", label: "Trades" },
            { id: "holders", label: "Holders" },
            { id: "backing", label: "Backing" },
            { id: "about", label: "About" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "trades" && <TradesPanel token={token!} symbol={symbol} now={now} />}
        {tab === "holders" && <HoldersPanel token={token!} creator={creator} treasury={treasury} now={now} />}
        {tab === "backing" &&
          (backing ? (
            <BackingPanel backing={backing} symbol={symbol ?? ""} now={now} />
          ) : (
            <div className="card p-5 text-sm text-text-muted">No treasury</div>
          ))}
        {tab === "about" && (
          <div className="space-y-4">
            {metaDenied && (
              <section className="card border-warning-border bg-warning-bg p-5" role="note">
                <div className="flex items-center justify-between gap-3">
                  <span className="chip chip-warning">Metadata withheld</span>
                  <Link href="/docs/content-policy" className="text-xs text-text-faint underline underline-offset-2">
                    Content policy ↗
                  </Link>
                </div>
                {denyReason && <p className="mt-2 text-sm text-text-secondary">{denyReason}</p>}
                {ipfsToGateway(metadataURI) && (
                  <a
                    className="mt-2 inline-block text-xs text-text-faint underline underline-offset-2 hover:text-text-secondary"
                    href={ipfsToGateway(metadataURI)}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                  >
                    Raw metadata ↗
                  </a>
                )}
              </section>
            )}

            <ProtocolTokenNotice token={token} />

            {shownMeta && (shownMeta.description || shownMeta.website || shownMeta.x || shownMeta.telegram) && (
              <section className="card p-5">
                <h2 className="section-label">About</h2>
                {shownMeta.description && <p className="mt-2 text-sm text-text-secondary">{shownMeta.description}</p>}
                <ProjectLinks meta={shownMeta} variant="row" className="mt-3" />
              </section>
            )}

            <AllocationSlot />
            <VerificationPanel token={token} />
            <MetadataHistory launchUri={launchMetadataURI} currentUri={metadataURI} changed={metadataChanged} />
            <CreatorTrackRecord creator={creator} thisToken={token!} />
            <MarketPanel token={token!} chainPriceUsd={marketPriceUsd} />

            <a
              href={`${activeChain.blockExplorers.default.url}/address/${treasury}`}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-xs text-text-faint hover:text-text-secondary"
            >
              Treasury on-chain ↗
            </a>
          </div>
        )}
      </MotionSection>
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

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <h1 className="font-serif font-semibold text-bone">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}

// Loading skeleton shaped like the real token page — header card (logo, name,
// price) above the stat strip — so the layout doesn't jump when the chain
// reads land.
function TokenSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="card p-5">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 animate-pulse rounded-full bg-surface-raised" />
          <div className="space-y-2">
            <div className="h-6 w-24 animate-pulse rounded bg-surface-raised" />
            <div className="h-3 w-36 animate-pulse rounded bg-surface-raised" />
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <div className="h-5 w-16 animate-pulse rounded bg-surface-raised" />
          <div className="h-5 w-24 animate-pulse rounded bg-surface-raised" />
        </div>
      </div>
      <div className="card p-4">
        <div className="h-16 w-full animate-pulse rounded bg-surface-raised" />
      </div>
    </div>
  );
}
