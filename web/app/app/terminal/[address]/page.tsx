"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useDenylistEntry } from "@/hooks/useDenylist";
import { useMarket } from "@/hooks/useMarket";
import { useOhlcv } from "@/hooks/useOhlcv";
import { useNow } from "@/hooks/useNow";
import { TerminalStatStrip } from "@/components/app/terminal/TerminalStatStrip";
import { TerminalChart } from "@/components/app/terminal/TerminalChart";
import { TerminalBackingPanel } from "@/components/app/terminal/TerminalBackingPanel";
import { TerminalTreasuryPanel } from "@/components/app/terminal/TerminalTreasuryPanel";
import { TerminalMarketPanel } from "@/components/app/terminal/TerminalMarketPanel";
import { TerminalProjectState } from "@/components/app/terminal/TerminalProjectState";
import { TerminalTabs } from "@/components/app/terminal/TerminalTabs";
import { TerminalStatusBar } from "@/components/app/terminal/TerminalStatusBar";
import { SwapPanel } from "@/components/app/SwapPanel";
import { Meander } from "@/components/Meander";
import { DEFAULT_TIMEFRAME, marketCapSupply, type Timeframe } from "@/lib/market";
import { ipfsToGateway } from "@/lib/ipfs";

// TERMINAL — a dense, single-screen working surface for people actually trading,
// keyed by the TOKEN address. The shareable token page (/app/token/[address]) stays
// as-is; this is the terminal (docs/Ballast-terminal). Backing is a first-class
// figure here, never a footnote, and every number carries a source + age.
//
// Complete: top strip + chart, the under-chart tabs (Trades · Holders · Top traders ·
// Your position), a right rail (swap · market · backing · treasury · project state),
// and a live status bar. No placeholders remain.
export default function TerminalPage() {
  const params = useParams();
  const raw = typeof params.address === "string" ? params.address : "";
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(raw);
  const token = isAddr ? (raw as Address) : undefined;

  const now = useNow();
  const [tf, setTf] = useState<Timeframe>(DEFAULT_TIMEFRAME);

  const b = useBacking(token);
  const { meta } = useProjectMeta(b.metadataURI);
  const { market } = useMarket(token);
  const { ohlcv, isLoading: ohlcvLoading, available: ohlcvAvailable } = useOhlcv(token, tf);
  const { denied } = useDenylistEntry(token);
  const shownMeta = denied ? undefined : meta;

  if (!isAddr) return <Notice title="Invalid address" body="This page needs a valid token address." />;
  if (!b.isConfigured) {
    return <Notice title="Not configured" body="BackingLens isn't set. Deploy the core contracts and set NEXT_PUBLIC_LENS_ADDRESS." />;
  }
  if (b.isLoading) return <Notice title="Loading…" body="Reading token, treasury, and backing from chain." />;
  if (!b.found || !b.treasury) {
    return <Notice title="Nothing here" body="No BALLAST token found at this address on the active chain." />;
  }

  const ballasted = Boolean(b.backing && b.backing.totalValueUsd > 0n);
  const priceUsdNum =
    b.marketPriceUsd !== undefined ? Number(b.marketPriceUsd) / 1e18 : market?.priceUsd;
  const supply = marketCapSupply(b.backing?.totalSupply, b.totalSupply);

  return (
    // Break out of the shared 1200px app column: the terminal is designed for 1440+
    // and needs the width to run a real 62/38 split. overflow-x-clip keeps the 100vw
    // block from introducing a horizontal scrollbar.
    <div className="relative left-1/2 w-screen max-w-[100vw] -translate-x-1/2 overflow-x-clip">
      <div className="mx-auto max-w-[1600px] space-y-3 px-4 xl:px-6">
        <TerminalStatStrip
          token={token!}
          symbol={b.symbol}
          name={b.name}
          logoSrc={ipfsToGateway(shownMeta?.logo)}
          metaWithheld={denied}
          priceUsd1e18={b.marketPriceUsd}
          priceFallbackNum={market?.priceUsd}
          ballasted={ballasted}
          backingPerToken1e18={b.backing?.backingPerToken}
          change24hPct={market?.change24hPct}
          volume24hUsd={market?.volume24hUsd}
          marketFetchedAt={market?.fetchedAt}
          now={now}
        />

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start xl:grid-cols-[minmax(0,1.63fr)_1fr]">
          {/* Left + centre: chart, then the under-chart tabs. */}
          <div className="min-w-0 space-y-3">
            <TerminalChart
              candles={ohlcv?.candles ?? []}
              timeframe={tf}
              onTimeframe={setTf}
              source={ohlcv?.source ?? "GeckoTerminal"}
              fetchedAt={ohlcv?.fetchedAt}
              loading={ohlcvLoading}
              available={ohlcvAvailable}
            />
            <TerminalTabs
              token={token!}
              symbol={b.symbol}
              creator={b.creator}
              treasury={b.treasury}
              priceUsd={priceUsdNum}
              now={now}
            />
          </div>

          {/* Right rail: swap · market · backing · treasury · project state. */}
          <div className="space-y-3">
            <SwapPanel dense token={token!} symbol={b.symbol ?? "TOKEN"} hasPool={b.hasPool} spotPriceWeth={b.marketPriceWeth} />
            <TerminalMarketPanel
              marketPriceUsd={b.marketPriceUsd}
              supply={supply}
              liquidityUsd={market?.top?.reserveUsd}
              now={now}
              marketFetchedAt={market?.fetchedAt}
            />
            <TerminalBackingPanel backing={b.backing} symbol={b.symbol ?? ""} now={now} />
            <TerminalTreasuryPanel backing={b.backing} now={now} />
            <TerminalProjectState
              creator={b.creator}
              treasury={b.treasury}
              graduated={b.graduated}
              hasPool={b.hasPool}
              noticePeriod={b.noticePeriod}
              pending={b.pending}
              now={now}
            />
          </div>
        </div>

        <TerminalStatusBar now={now} />

        <Meander className="opacity-40" />
      </div>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h1 className="font-serif font-semibold text-bone">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
      <Link href="/app/discover" className="mt-4 inline-block text-xs text-green underline underline-offset-2">
        Back to Discover
      </Link>
    </div>
  );
}
