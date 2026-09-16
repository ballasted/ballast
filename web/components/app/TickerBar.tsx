"use client";

import { useProtocolStats } from "@/hooks/useProtocolStats";
import { useAnalyticsSeries } from "@/hooks/useAnalyticsSeries";
import { useEthUsd } from "@/hooks/useEthUsd";
import { useGasPrice } from "@/hooks/useGasPrice";
import { useBallastMarket } from "@/hooks/useBallastMarket";
import { formatUsd } from "@/lib/format";
import { formatCompactUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

// Bottom scrolling ticker (spec §4, App shell). Fixed at the viewport bottom,
// offset past the SideNav, lg+ only. Every figure here is real — chain reads
// for TVL/ETH/gas/$BALLAST price, GeckoTerminal for 24h volume and $BALLAST's
// 24h% — and a figure that isn't available yet renders "—", never a guess.
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
    <div className="fixed inset-x-0 bottom-0 z-20 hidden h-7 overflow-hidden border-t border-border bg-bg/95 backdrop-blur lg:left-60 lg:flex">
      <div className="group flex w-full overflow-hidden">
        <div className="ticker-track flex shrink-0 items-center gap-8 whitespace-nowrap pl-4 [animation-play-state:running] group-hover:[animation-play-state:paused]">
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
