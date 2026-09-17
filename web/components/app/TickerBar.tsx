"use client";

import { useProtocolStats } from "@/hooks/useProtocolStats";
import { useAnalyticsSeries } from "@/hooks/useAnalyticsSeries";
import { useEthUsd } from "@/hooks/useEthUsd";
import { useGasPrice } from "@/hooks/useGasPrice";
import { useBallastMarket } from "@/hooks/useBallastMarket";
import { formatUsd } from "@/lib/format";
import { formatCompactUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

// Scrolling ticker (spec §4, App shell). Sits in normal flow directly under
// TopBar, lg+ only — NOT fixed, so it doesn't need a hasRail offset or a
// bottom-padding reservation on <main>: it just shifts right along with the
// rest of the shell when SideNav's lg:pl-60 applies. Every figure here is
// real — chain reads for TVL/ETH/gas/$BALLAST price, GeckoTerminal for 24h
// volume and $BALLAST's 24h% — and a figure that isn't available yet renders
// "—", never a guess.
export function TickerBar() {
  const { isLoading: statsLoading, totalMarketCapUsd, pricedCount } = useProtocolStats();
  const { volume24hUsd, available: volumeAvailable } = useAnalyticsSeries();
  const { ethUsd1e18 } = useEthUsd();
  const { gasPriceWei } = useGasPrice();
  const ballast = useBallastMarket();

  const items = [
    {
      label: "Ballast market cap",
      value: !statsLoading && pricedCount > 0 ? formatUsd(totalMarketCapUsd, { compact: true }) : "—",
    },
    { label: "24h volume", value: volumeAvailable && volume24hUsd !== undefined ? formatCompactUsd(volume24hUsd) : "—" },
    { label: "ETH", value: ethUsd1e18 !== undefined ? formatUsd(ethUsd1e18) : "—" },
    {
      label: "Gas",
      value: gasPriceWei !== undefined ? `${(Number(gasPriceWei) / 1e9).toFixed(2)} gwei` : "—",
    },
    {
      label: "$BALLAST",
      value: ballast.marketCapUsd1e18 !== undefined ? formatUsd(ballast.marketCapUsd1e18, { compact: true }) : "—",
      change: ballast.change24hPct,
    },
  ];

  return (
    <div className="relative z-20 hidden h-8 overflow-hidden border-b border-border bg-bg/95 lg:flex">
      {/* Faint patina underglow along the bottom edge — a quiet "this row is live"
          cue instead of a loud one, in keeping with the app's restraint. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-60"
        style={{ background: "linear-gradient(90deg, rgba(34,201,58,0.4), rgba(34,201,58,0.05) 60%, transparent)" }}
        aria-hidden
      />
      <div className="group flex w-full items-center overflow-hidden pl-4">
        <span className="mr-6 flex shrink-0 items-center gap-1.5 text-xs font-semibold text-green">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-green" aria-hidden />
          Live
        </span>
        <div className="flex w-full overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_4%,#000_96%,transparent)]">
          <div className="ticker-track flex shrink-0 items-center gap-8 whitespace-nowrap [animation-play-state:running] group-hover:[animation-play-state:paused]">
            {[0, 1].map((rep) => (
              <div key={rep} className="flex items-center gap-8">
                {items.map((item, i) => (
                  <TickerItem key={`${rep}-${i}`} {...item} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TickerItem({ label, value, change }: { label: string; value: string; change?: number }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-xs tabular-nums text-text-secondary">
      <span className="text-text-faint">{label}</span>
      <span className="text-text-primary">{value}</span>
      {change !== undefined && (
        <span className={cn(change >= 0 ? "text-green" : "text-negative")}>
          {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
        </span>
      )}
    </span>
  );
}
