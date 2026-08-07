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
import { SwapPanel } from "@/components/app/SwapPanel";
import { Meander } from "@/components/Meander";
import { DEFAULT_TIMEFRAME, type Timeframe } from "@/lib/market";
import { ipfsToGateway } from "@/lib/ipfs";

// TERMINAL — a dense, single-screen working surface for people actually trading,
// keyed by the TOKEN address. The shareable token page (/app/token/[address]) stays
// as-is; this is the terminal (docs/Ballast-terminal). Backing is a first-class
// figure here, never a footnote, and every number carries a source + age.
//
// This slice builds the top strip + chart only (terminal stop point 2 — density
// check). The right rail (swap, backing, treasury, project state), the under-chart
// tabs, and the bottom status bar are stubbed as labelled placeholders so the column
// proportions are judgeable, and land in the next slices.
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
          {/* Left + centre: chart, then the under-chart tabs (next slice) */}
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
            <Placeholder label="Tabs · Trades · Holders · Top traders · Your position" note="next slice" tall />
          </div>

          {/* Right rail: swap (this slice), then market · backing · treasury ·
              project state (next slice). */}
          <div className="space-y-3">
            <SwapPanel dense token={token!} symbol={b.symbol ?? "TOKEN"} hasPool={b.hasPool} spotPriceWeth={b.marketPriceWeth} />
            <Placeholder label="Market · backing · treasury · project state" note="next slice" />
          </div>
        </div>

        {/* Bottom status bar (next slice): block · connection · RPC latency · last update */}
        <div className="flex items-center justify-between rounded-input border border-border px-3 py-1.5 text-[11px] text-text-faint">
          <span>Status bar — block · connection · RPC latency · last update</span>
          <span className="italic">next slice</span>
        </div>

        <Meander className="opacity-40" />
      </div>
    </div>
  );
}

// Muted, dashed stub so the column proportions read at the density check without
// investing in throwaway UI. Clearly not real content.
function Placeholder({ label, note, tall }: { label: string; note: string; tall?: boolean }) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-card border border-dashed border-border px-4 text-center"
      style={{ minHeight: tall ? 220 : 120 }}
    >
      <span className="text-sm text-text-muted">{label}</span>
      <span className="mt-1 text-[11px] italic text-text-faint">{note}</span>
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
