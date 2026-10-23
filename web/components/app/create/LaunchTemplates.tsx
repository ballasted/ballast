"use client";

import { useMemo, useState } from "react";
import type { Address } from "viem";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";
import { availableTemplates, PARENT_BALLAST_ADDRESS, type LiveContext, type LaunchTemplate } from "@/lib/launchTemplates";

type AssetLike = { address: Address; symbol?: string };
type QuoteOption = { address: Address; symbol?: string; isWeth?: boolean };

// Tickers whose logo asset is an SVG (everything else in /public/assets/tickers
// is a PNG). Kept in sync with the files that ship there.
const SVG_TICKERS = new Set(["SGOV", "WETH", "BTC", "ETH", "USDC", "USDT"]);

/** The ticker a template is "about", for its leading mark — treasury first, else
 *  the first paired stock. Null templates fall back to a glyph. */
function accentTicker(t: LaunchTemplate): string | null {
  if (t.plan.treasuryTicker) return t.plan.treasuryTicker.toUpperCase();
  const first = t.plan.pairTickers?.[0];
  if (first) return first.toUpperCase();
  return null;
}

/** Per-key glyph for templates that aren't anchored to one ticker. Flat line
 *  marks in the patina accent — no emoji, matching the app's icon language. */
function Glyph({ k }: { k: string }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (k) {
    case "burn-heavy":
      // flame
      return (
        <svg {...common}>
          <path d="M12 3c3 3 4 5 4 8a4 4 0 0 1-8 0c0-1 .3-1.8 1-2.6C9.6 9.8 10 8.3 10 7c1 1 1.6 1.8 2 2 0-2 0-4 0-6Z" />
        </svg>
      );
    case "community":
      // people
      return (
        <svg {...common}>
          <circle cx="8.5" cy="9" r="2.4" />
          <circle cx="16" cy="10" r="2" />
          <path d="M4 18c0-2.2 2-3.6 4.5-3.6S13 15.8 13 18M14 18c0-1.7 1.3-3 3-3s3 1 3 2.6" />
        </svg>
      );
    case "family":
      // linked nodes (parent → children)
      return (
        <svg {...common}>
          <circle cx="12" cy="5" r="2" />
          <circle cx="6" cy="18" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M12 7v3m0 0l-5 6m5-6l5 6" />
        </svg>
      );
    default:
      // keel mark
      return (
        <svg {...common}>
          <path d="M3 7h18" />
          <path d="M12 7v6m0 0l-4 4h8l-4-4z" />
        </svg>
      );
  }
}

/** Leading mark for a template card — the real ticker logo when we have one,
 *  otherwise the keyed glyph. Logo failures fall back to the glyph too. */
function TemplateMark({ t }: { t: LaunchTemplate }) {
  const ticker = accentTicker(t);
  const [broken, setBroken] = useState(false);
  const box =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-green";
  if (ticker && !broken) {
    const ext = SVG_TICKERS.has(ticker) ? "svg" : "png";
    return (
      <span className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/assets/tickers/${ticker}.${ext}`}
          alt=""
          width={22}
          height={22}
          className="h-[22px] w-[22px] rounded-full object-contain"
          onError={() => setBroken(true)}
        />
      </span>
    );
  }
  return (
    <span className={box}>
      <Glyph k={t.key} />
    </span>
  );
}

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
  const [appliedKey, setAppliedKey] = useState<string | null>(null);

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
    setAppliedKey(t.key);
  }

  return (
    <section className="card p-5">
      <div className="flex items-baseline justify-between">
        <span className="section-label">Templates</span>
        <span className="text-xs text-text-muted">Suggestions — edit anything before you sign</span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {templates.map((t) => {
          const active = appliedKey === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => apply(t)}
              aria-pressed={active}
              className={[
                "group relative flex items-center gap-3 rounded-input border p-3 text-left transition-colors",
                active
                  ? "border-green bg-green-bg"
                  : "border-border bg-bg hover:border-border-strong hover:bg-surface-hover",
              ].join(" ")}
              title={`Apply the ${t.label} template`}
            >
              <TemplateMark t={t} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={active ? "text-sm font-medium text-green" : "text-sm font-medium text-bone"}>
                  {t.label}
                </span>
                <span className="truncate text-[11px] text-text-muted">{t.blurb}</span>
              </span>
              {active ? (
                <svg
                  className="absolute right-3 top-3 text-green"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
