"use client";

import { useAccount } from "wagmi";
import { usePortfolio } from "@/hooks/usePortfolio";
import { formatUsd } from "@/lib/format";

// Top-bar portfolio value (spec §4, App shell). Reuses usePortfolio's totals
// exactly — the portfolio page and this chip can never disagree, since
// there's only one place the value is computed. `data-balance` is what
// useBlurBalances' CSS rule targets.
export function PortfolioValueChip() {
  const { isConnected } = useAccount();
  const { isLoading, isConfigured, totalValue } = usePortfolio();

  if (!isConnected) return null;

  return (
    <span className="hidden items-center gap-1.5 rounded-pill border border-border bg-card px-3 py-1.5 text-sm sm:flex" title="Portfolio value">
      <span className="eyebrow">Portfolio</span>
      <span data-balance className="font-mono tabular-nums text-text-primary">
        {!isConfigured ? "—" : isLoading ? "···" : formatUsd(totalValue, { compact: true })}
      </span>
    </span>
  );
}
