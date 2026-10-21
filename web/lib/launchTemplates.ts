import type { Address } from "viem";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";
import { BALLAST_V2_TOKEN_ADDRESS } from "@/lib/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Launch templates — curated one-click presets for the Create page. They only
// PRE-FILL the form; the creator can edit everything before signing. Defined here
// in one config, curated by us. They use ONLY live assets/features: a template is
// hidden when the asset it needs isn't allowlisted/routable or the feature it needs
// (e.g. FeeRouter v2 for a parent-burn share) isn't active.
//
// Copy rule: templates are SUGGESTIONS, not advice. No "yield/reward/floor/
// guaranteed/safe" anywhere here.
// ─────────────────────────────────────────────────────────────────────────────

export type TemplatePlan = {
  /** Add these quote-asset tickers to the pairing (WETH is always kept). */
  pairTickers?: string[];
  /** Treasury mode: "ballast" seeds a backing treasury, "none" is unbacked. */
  mode?: "ballast" | "none";
  /** Treasury asset ticker (when mode === "ballast"). */
  treasuryTicker?: string;
  /** Withdrawal notice in days. */
  noticeDays?: 7 | 30 | 90;
  /** 5-bucket fee split (bps, sums to 10000). treasuryBps stays 0 (bucket disabled). */
  split: FeeSplitBps;
  /** Set the family parent to $BALLAST v2 (requires FeeRouter v2). */
  parentBallast?: boolean;
};

export type LaunchTemplate = {
  key: string;
  label: string;
  /** One short line, shown under the chip. Labels and numbers only. */
  blurb: string;
  plan: TemplatePlan;
  /** Requirements for the template to be offered at all. */
  requires: {
    /** Tickers that must be present in the live quote options / allowlist. */
    assets?: string[];
    /** Needs a non-100%-creator split routed through a FeeRouter. */
    feeRouter?: boolean;
    /** Needs FeeRouter v2 specifically (parent-burn bucket). */
    feeRouterV2?: boolean;
  };
};

const BPS = 10000;

export const LAUNCH_TEMPLATES: LaunchTemplate[] = [
  {
    key: "ai",
    label: "AI",
    blurb: "NVDA pair · 50 / 25 / 25",
    plan: {
      pairTickers: ["NVDA"],
      mode: "none",
      split: { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, parentBurnBps: 0, rewardsBps: 2500 },
    },
    requires: { assets: ["NVDA"], feeRouter: true },
  },
  {
    key: "cash-like",
    label: "Cash-like",
    blurb: "SGOV treasury · 90-day notice",
    plan: {
      mode: "ballast",
      treasuryTicker: "SGOV",
      noticeDays: 90,
      split: { creatorBps: BPS, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 },
    },
    requires: { assets: ["SGOV"] },
  },
  {
    key: "burn-heavy",
    label: "Burn-heavy",
    blurb: "creator 20 · buyback 80",
    plan: {
      mode: "none",
      split: { creatorBps: 2000, treasuryBps: 0, buybackBps: 8000, parentBurnBps: 0, rewardsBps: 0 },
    },
    requires: { feeRouter: true },
  },
  {
    key: "community",
    label: "Community",
    blurb: "stakers-heavy · 25 / 0 / 75",
    plan: {
      mode: "none",
      split: { creatorBps: 2500, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 7500 },
    },
    requires: { feeRouter: true },
  },
  {
    key: "family",
    label: "Family",
    blurb: "parent $BALLAST · parent burn 20",
    plan: {
      mode: "none",
      parentBallast: true,
      split: { creatorBps: 6000, treasuryBps: 0, buybackBps: 2000, parentBurnBps: 2000, rewardsBps: 0 },
    },
    requires: { feeRouterV2: true },
  },
  // "Basket" is intentionally omitted: the Create page's treasury modes are
  // "ballast" | "none" — there is no basket-treasury mode on Create to pre-fill,
  // so a Basket template would have nothing to apply. Add it here once the basket
  // flow lands on Create.
];

export type LiveContext = {
  /** Allowlisted/quotable tickers available right now (WETH + stock quote assets). */
  availableTickers: Set<string>;
  feeRouterActive: boolean;
  feeRouterV2Active: boolean;
};

/** Which templates are offerable given the live assets/features. */
export function availableTemplates(ctx: LiveContext): LaunchTemplate[] {
  return LAUNCH_TEMPLATES.filter((t) => {
    if (t.requires.assets && !t.requires.assets.every((a) => ctx.availableTickers.has(a.toUpperCase()))) return false;
    if (t.requires.feeRouterV2 && !ctx.feeRouterV2Active) return false;
    if (t.requires.feeRouter && !ctx.feeRouterActive) return false;
    return true;
  });
}

export const PARENT_BALLAST_ADDRESS: Address = BALLAST_V2_TOKEN_ADDRESS;
