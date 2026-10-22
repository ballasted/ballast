"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";
import { availableTemplates, PARENT_BALLAST_ADDRESS, type LiveContext, type LaunchTemplate } from "@/lib/launchTemplates";

type AssetLike = { address: Address; symbol?: string };
type QuoteOption = { address: Address; symbol?: string; isWeth?: boolean };

export function LaunchTemplates(props: {
  assets: AssetLike[];
  quoteOptions: QuoteOption[];
  feeRouterActive: boolean;
  feeRouterV2Active: boolean;
  // setters (same ones CreateFlow owns)
  setQuoteAssets: (a: Address[]) => void;
  setMode: (m: "ballast" | "none") => void;
  setAssetAddr: (a: Address | "") => void;
  setNoticeDays: (d: 7 | 30 | 90) => void;
  setRouterSplit: (s: FeeSplitBps) => void;
}) {
  const ctx: LiveContext = useMemo(() => {
    const tickers = new Set<string>();
    for (const q of props.quoteOptions) if (q.symbol) tickers.add(q.symbol.toUpperCase());
    for (const a of props.assets) if (a.symbol) tickers.add(a.symbol.toUpperCase());
    return { availableTickers: tickers, feeRouterActive: props.feeRouterActive, feeRouterV2Active: props.feeRouterV2Active };
  }, [props.quoteOptions, props.assets, props.feeRouterActive, props.feeRouterV2Active]);

  const templates = useMemo(() => availableTemplates(ctx), [ctx]);

  if (templates.length === 0) return null;

  function apply(t: LaunchTemplate) {
    const p = t.plan;
    // Pairing: always keep WETH, then add any resolvable stock quote assets.
    if (p.pairTickers) {
      const weth = props.quoteOptions.find((o) => o.isWeth)?.address;
      const resolved = p.pairTickers
        .map((tk) => props.quoteOptions.find((o) => o.symbol?.toUpperCase() === tk.toUpperCase())?.address)
        .filter((a): a is Address => Boolean(a));
      const next = [...(weth ? [weth] : []), ...resolved].filter((a, i, arr) => arr.indexOf(a) === i);
      if (next.length) props.setQuoteAssets(next);
    }
    if (p.mode) props.setMode(p.mode);
    if (p.mode === "ballast" && p.treasuryTicker) {
      const asset = props.assets.find((a) => a.symbol?.toUpperCase() === p.treasuryTicker!.toUpperCase());
      if (asset) props.setAssetAddr(asset.address);
    }
    if (p.noticeDays) props.setNoticeDays(p.noticeDays);
    const split: FeeSplitBps = { ...p.split };
    if (p.parentBallast) split.parent = PARENT_BALLAST_ADDRESS;
    props.setRouterSplit(split);
  }

  return (
    <section className="card">
      <div className="flex items-baseline justify-between">
        <span className="section-label">Templates</span>
        <span className="text-xs text-text-muted">Suggestions — edit anything before you sign</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {templates.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => apply(t)}
            className="chip flex cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-left transition hover:border-accent/50"
            title={`Apply the ${t.label} template`}
          >
            <span className="text-sm font-medium text-bone">{t.label}</span>
            <span className="text-[11px] text-text-muted">{t.blurb}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
