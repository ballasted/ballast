"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useDenylistEntry } from "@/hooks/useDenylist";
import { useMarket } from "@/hooks/useMarket";
import { useNow } from "@/hooks/useNow";
import { useAssets } from "@/hooks/useAssets";
import { useBasketHistory } from "@/hooks/useBasketHistory";
import { useRamsesPosition } from "@/hooks/useRamsesPosition";
import { BackedByChip, PoolChips } from "@/components/app/LaunchChips";
import { ResumeLaunchPanel } from "@/components/app/ResumeLaunchPanel";
import { MarketPanel } from "@/components/app/token/MarketPanel";
import { ProtocolTokenNotice } from "@/components/app/token/ProtocolTokenNotice";
import { PendingWithdrawalBanner } from "@/components/app/PendingWithdrawalBanner";
import { SwapPanel } from "@/components/app/SwapPanel";
import { FeePanel } from "@/components/app/FeePanel";
import { FeeRouterCard } from "@/components/app/token/FeeRouterCard";
import { FeeSplitInfo } from "@/components/app/token/FeeSplitInfo";
import { StakingPanel } from "@/components/app/token/StakingPanel";
import { FeeRouterDashboard } from "@/components/app/token/FeeRouterDashboard";
import { PlainEnglishCard } from "@/components/app/token/PlainEnglishCard";
import {
  AllocationSlot,
  MetadataHistory,
  CreatorTrackRecord,
  HoldersPanel,
  TradesPanel,
} from "@/components/app/token/TokenSections";
import { cn } from "@/lib/cn";
import { TokenStatRow } from "@/components/app/token/TokenStatRow";
import { PriceChart } from "@/components/app/token/PriceChart";
import { WETH_ADDRESS, isBasketEnabled, isRamsesEnabled, isRetiredToken, RETIRED_NOTICES, BALLAST_V2_TOKEN_ADDRESS } from "@/lib/contracts";
import { useHolders } from "@/hooks/useHolders";
import { AssetDisc } from "@/components/app/AssetDisc";
import { VerificationPanel } from "@/components/app/VerificationPanel";
import { SecurityChecksPanel } from "@/components/app/token/SecurityChecksPanel";
import { ProtocolControlsPanel } from "@/components/app/ProtocolControlsPanel";
import { LiquidityDepthNote } from "@/components/app/LiquidityDepthNote";
import { ProjectLinks } from "@/components/app/ProjectLinks";
import { MotionSection } from "@/components/app/MotionSection";
import { activeChain } from "@/lib/chain";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress, formatUsd } from "@/lib/format";

type BackingAssetView = { asset: `0x${string}`; withdrawableBalance: bigint; assetDecimals: number };
type TabId = "trades" | "holders" | "about";

// Token detail — the shareable unit, keyed by the TOKEN address. Header + stat
// strip + chart/trade side by side, nothing else above the fold; everything
// else lives behind the four tabs below (UI principles).
export default function TokenDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const raw = typeof params.address === "string" ? params.address : "";
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(raw);
  const token = isAddr ? (raw as Address) : undefined;
  const retired = isRetiredToken(token);

  // Old deep link into the since-removed Backing tab -> its own page now.
  useEffect(() => {
    if (token && searchParams.get("tab") === "backing") {
      router.replace(`/app/backing/${token}`);
    }
  }, [token, searchParams, router]);

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
    quoteAssets,
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
  const [tab, setTab] = useState<TabId>("trades");
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

  // Lazy, best-effort badges for the Backing summary card below — same
  // event-sourced hooks the dedicated /app/backing/[address] page's sections
  // already use, just read here for the one-line summary.
  const basket = useBasketHistory(token);
  const ramses = useRamsesPosition(token);

  // The chart's USD/quote-asset unit switch needs the pool's non-WETH quote asset
  // (a stock, e.g. NVDA) and ITS live USD price from the SAME allowlist feed read
  // useAssets already does for the create flow — never re-derived here. A WETH-
  // only pool has no such asset, so the switch stays hidden (PriceChart handles that).
  const stockQuoteAsset = (quoteAssets ?? []).find((a) => !WETH_ADDRESS || a.toLowerCase() !== WETH_ADDRESS.toLowerCase());
  const stockAssetInfo = stockQuoteAsset ? registry.find((a) => a.address.toLowerCase() === stockQuoteAsset.toLowerCase()) : undefined;
  const quoteUsdPrice =
    stockAssetInfo?.price !== undefined && stockAssetInfo?.priceDecimals !== undefined
      ? Number(stockAssetInfo.price) / 10 ** stockAssetInfo.priceDecimals
      : undefined;
  // Fastest real price available: on-chain (12s cadence) first, GeckoTerminal
  // (60s) otherwise — both real reads, never a fabricated interpolation.
  const livePriceUsd = marketPriceUsd !== undefined ? Number(marketPriceUsd) / 1e18 : market?.priceUsd;

  if (!isAddr) return <Notice title="Invalid address" body="This page needs a valid token address." />;
  // Retired token (e.g. $BALLAST v1): reachable, but short-circuit to a minimal
  // read-only page — the migrated banner + a link to v2, no buy/sell. Done BEFORE
  // the loading/found gates so it renders regardless of whether the backing reads
  // resolve (a retired token's treasury reads can be slow or absent).
  if (retired) {
    return (
      <div className="space-y-4">
        <RetiredBanner token={token!} />
        <RetiredSwapNote token={token!} />
      </div>
    );
  }
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
            <BackedByChip backingAsset={backingAsset?.asset} registry={registry} registryLoaded={!registryLoading} />
            <PoolChips quoteAssets={quoteAssets ?? []} registry={registry} registryLoaded={!registryLoading} />
            <span className={cn("chip", hasPool ? "chip-accent" : "chip-neutral")}>{hasPool ? "Graduated" : "On curve"}</span>
            <LiquidityDepthNote depthToDoubleUsd={depthToDoubleUsd} />
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
          <PriceChart
            token={token!}
            quoteSymbol={stockAssetInfo?.symbol}
            quoteUsdPrice={quoteUsdPrice}
            livePriceUsd={livePriceUsd}
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

      {/* ── Backing summary — a pointer to the dedicated page, not a re-render
          of its content (no duplicate UI). Always visible, not tab-gated. ── */}
      <MotionSection>
        <BackingSummaryCard
          token={token!}
          backingUsd={backing?.totalValueUsd}
          hasBasket={isBasketEnabled && basket.hasHistory}
          hasRamsesLock={isRamsesEnabled && Boolean(ramses.position)}
        />
      </MotionSection>

      {/* ── Tabs: Trades · Holders · About. ── */}
      <MotionSection>
        <TabBar
          tabs={[
            { id: "trades", label: "Trades" },
            { id: "holders", label: "Holders" },
            { id: "about", label: "About" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "trades" && <TradesPanel token={token!} symbol={symbol} now={now} />}
        {tab === "holders" && <HoldersPanel token={token!} creator={creator} treasury={treasury} now={now} />}
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

            <PlainEnglishCard token={token!} />

            {/* The launch's swap-fee split, read from ITS generation's FeeConfig
                (gen-4 = 80/20/0; gen-1..3 show their own 50/35/15). */}
            <FeeSplitInfo factory={ownerFactory} />

            <FeeRouterCard token={token} factory={ownerFactory} />
            <StakingPanel token={token} symbol={symbol} />
            <FeeRouterDashboard token={token} />

            {shownMeta && (shownMeta.description || shownMeta.website || shownMeta.x || shownMeta.telegram) && (
              <section className="card p-5">
                <h2 className="section-label">About</h2>
                {shownMeta.description && <p className="mt-2 text-sm text-text-secondary">{shownMeta.description}</p>}
                <ProjectLinks meta={shownMeta} variant="row" className="mt-3" />
              </section>
            )}

            <AllocationSlot />
            <VerificationPanel token={token} />
            <SecurityChecksPanel token={token} />
            <ProtocolControlsPanel ownerFactory={ownerFactory} token={token} creator={creator} />
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

// One line, links through to /app/backing/[address] (the full treasury,
// stock basket, and Ramses-lock sections now live there — never duplicated
// here). Always shown, including $0 backing, so the link is never a surprise.
function BackingSummaryCard({
  token,
  backingUsd,
  hasBasket,
  hasRamsesLock,
}: {
  token: Address;
  backingUsd?: bigint;
  hasBasket: boolean;
  hasRamsesLock: boolean;
}) {
  const bits = [formatUsd(backingUsd ?? 0n, { compact: true }) + " in treasury"];
  if (hasBasket) bits.push("basket");
  if (hasRamsesLock) bits.push("Ramses lock");
  return (
    <Link href={`/app/backing/${token}`} className="card card-hover flex items-center justify-between gap-3 p-4">
      <span className="text-sm text-text-secondary">
        <span className="font-semibold text-text-primary">Backing:</span> {bits.join(" · ")}
      </span>
      <span className="text-text-faint" aria-hidden>→</span>
    </Link>
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

// Prominent top banner for a retired token (e.g. $BALLAST v1) — always shown,
// regardless of env/pinning, with a link to v2. Trading is disabled below.
function RetiredBanner({ token }: { token: Address }) {
  const notice = RETIRED_NOTICES[token.toLowerCase()];
  const migratedTo = notice?.migratedTo ?? BALLAST_V2_TOKEN_ADDRESS;
  return (
    <section className="card border-accent p-5" role="note">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="chip chip-neutral">v1 · migrated to v2</span>
        <Link href={`/app/token/${migratedTo}`} className="text-sm text-green underline underline-offset-2">
          View $BALLAST v2 ↗
        </Link>
      </div>
      <p className="mt-3 text-sm text-text-secondary">
        {notice?.message ?? "This token is retired."} It has been migrated to $BALLAST v2 — trading here is closed.
      </p>
    </section>
  );
}

// Replaces the SwapPanel for a retired token — no buy/sell, just a pointer to v2.
function RetiredSwapNote({ token }: { token: Address }) {
  const migratedTo = RETIRED_NOTICES[token.toLowerCase()]?.migratedTo ?? BALLAST_V2_TOKEN_ADDRESS;
  return (
    <section className="card p-5 text-center">
      <h2 className="section-label">Trading closed</h2>
      <p className="mt-2 text-sm text-text-muted">$BALLAST v1 is retired. Trade $BALLAST v2 instead.</p>
      <Link href={`/app/token/${migratedTo}`} className="btn-primary mt-4 inline-block px-5">
        Go to $BALLAST v2
      </Link>
    </section>
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
