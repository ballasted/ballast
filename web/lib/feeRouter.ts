import { formatDuration } from "@/lib/format";

export type RouterSplitBps = {
  creatorBps: number;
  treasuryBps: number;
  buybackBps: number;
  parentBurnBps: number;
  rewardsBps: number;
};
export type EffectiveSplit = {
  creator: number;
  treasury: number;
  buyback: number;
  parentBurn: number;
  stakers: number;
  platform: number;
  referrer: number;
};

/** The ordered keys of EffectiveSplit, newest buckets inserted in the on-chain
 *  route() order (creator → treasury → buyback → parentBurn → stakers), with the
 *  platform/referrer fee cuts last. */
export type EffectiveSplitKey = keyof EffectiveSplit;

/** Canonical per-bucket label + colour, shared by the create split-bar, the create
 *  preview "Fee split" row and the token page so all three read identically and the
 *  colours match the bar. Colours are Tailwind background classes. */
export const SPLIT_BUCKET_META: Record<EffectiveSplitKey, { label: string; color: string }> = {
  creator: { label: "Creator", color: "bg-green" },
  treasury: { label: "Treasury", color: "bg-bone/30" },
  buyback: { label: "Buyback & burn", color: "bg-warning" },
  parentBurn: { label: "Parent burn", color: "bg-negative" },
  stakers: { label: "Stakers", color: "bg-accent" },
  platform: { label: "Platform", color: "bg-bone/60" },
  referrer: { label: "Referrer", color: "bg-bone/40" },
};

/** Display order for the effective-split row/bar. */
export const EFFECTIVE_SPLIT_ORDER: EffectiveSplitKey[] = [
  "creator",
  "treasury",
  "buyback",
  "parentBurn",
  "stakers",
  "platform",
  "referrer",
];

/**
 * The effective split of the TOTAL swap fee, as whole percentages that always sum
 * to exactly 100. The platform (and any referrer) take their fixed cut of the fee;
 * the router divides the CREATOR share (`creatorPct` of the fee) across its five
 * buckets. Example: gen-4 fee split 80/20/0 + a router Custom 50/0/25/0/25 →
 * creator 40, buyback 20, stakers 20, platform 20.
 *
 * Rounding: largest-remainder over all components so the row the UI shows (and the
 * bar it draws) always totals 100% — no stray 99% / 101%.
 */
export function effectiveSplit(
  fee: { creatorPct: number; platformPct: number; referrerPct: number },
  router: RouterSplitBps,
): EffectiveSplit {
  // Exact (possibly fractional) percentage of the TOTAL fee for each component.
  const exact = {
    creator: fee.creatorPct * (router.creatorBps / 10000),
    treasury: fee.creatorPct * (router.treasuryBps / 10000),
    buyback: fee.creatorPct * (router.buybackBps / 10000),
    parentBurn: fee.creatorPct * (router.parentBurnBps / 10000),
    stakers: fee.creatorPct * (router.rewardsBps / 10000),
    platform: fee.platformPct,
    referrer: fee.referrerPct,
  };
  return roundTo100(exact) as EffectiveSplit;
}

/** The effective split as an ordered list of only the non-zero buckets (0% buckets
 *  hidden, per the spec), each with its label + colour for rendering. The list the
 *  create preview and the token page both map over. */
export function effectiveSplitParts(
  fee: { creatorPct: number; platformPct: number; referrerPct: number },
  router: RouterSplitBps,
): { key: EffectiveSplitKey; label: string; color: string; pct: number }[] {
  const e = effectiveSplit(fee, router);
  return EFFECTIVE_SPLIT_ORDER.filter((k) => e[k] > 0).map((k) => ({
    key: k,
    label: SPLIT_BUCKET_META[k].label,
    color: SPLIT_BUCKET_META[k].color,
    pct: e[k],
  }));
}

/** Largest-remainder rounding of a map of percentages to integers summing to 100
 *  (assumes the inputs themselves sum to ~100). */
function roundTo100<T extends Record<string, number>>(exact: T): T {
  const keys = Object.keys(exact) as (keyof T)[];
  const val = (k: keyof T) => exact[k] as number;
  const floors = {} as Record<keyof T, number>;
  let used = 0;
  for (const k of keys) {
    floors[k] = Math.floor(val(k));
    used += floors[k];
  }
  let remainder = Math.round(keys.reduce((s, k) => s + val(k), 0)) - used;
  // Hand the leftover units to the largest fractional parts, biggest first.
  const byFrac = [...keys].sort((a, b) => (val(b) - Math.floor(val(b))) - (val(a) - Math.floor(val(a))));
  for (let i = 0; remainder > 0 && i < byFrac.length; i++, remainder--) {
    const k = byFrac[i] as keyof T;
    floors[k] = floors[k] + 1;
  }
  return floors as T;
}

// Maps a decoded FeeRouter.route() revert (viem errorName from a preflight
// simulation) to a human reason shown in place of "Ready now", so the UI never
// offers a Route button that would revert on-chain. `nowSec`/`readyAtSec` give a
// precise Cooldown countdown. Pure + unit-tested.
export function routeRevertReason(errorName: string | undefined, nowSec: number, readyAtSec: number): string {
  switch (errorName) {
    case "NothingToRoute":
      return "No fees to route yet — trading has to generate fees first.";
    case "Cooldown":
      return readyAtSec > nowSec ? `On cooldown — ready in ${formatDuration(readyAtSec - nowSec)}.` : "On cooldown.";
    case "NotWired":
      return "This router isn't wired to a launch yet.";
    case "MinAmountOutNotMet":
      return "A bucket swap would move the price too far right now — try again shortly.";
    default:
      return errorName ? `Can't route right now (${errorName}).` : "Can't route right now.";
  }
}

/** Does the buyback bucket need its pool wired before route() can burn? True when
 *  buyback has (or will have) a non-zero share and the pool isn't wired yet —
 *  surfaces the permissionless "Wire buyback pool" next-step in the UI. */
export function needsBuybackWire(args: {
  buybackWired: boolean;
  buybackBps: number;
  hasPendingSplit: boolean;
  pendingBuybackBps: number;
}): boolean {
  const willBuyback = args.buybackBps > 0 || (args.hasPendingSplit && args.pendingBuybackBps > 0);
  return !args.buybackWired && willBuyback;
}

/** The parent-burn analogue of needsBuybackWire: true when the parentBurn bucket
 *  has (or will have) a non-zero share and the parent pool isn't wired yet. */
export function needsParentWire(args: {
  hasParent: boolean;
  parentWired: boolean;
  parentBurnBps: number;
  hasPendingSplit: boolean;
  pendingParentBurnBps: number;
}): boolean {
  if (!args.hasParent) return false;
  const willBurn = args.parentBurnBps > 0 || (args.hasPendingSplit && args.pendingParentBurnBps > 0);
  return !args.parentWired && willBurn;
}
