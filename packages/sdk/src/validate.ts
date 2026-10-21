import type { Address } from "viem";
import { SplitShapeError, ValidationError } from "./errors";
import type { FeeSplit } from "./reads";

/** Validate a 5-bucket fee split. Mirrors FeeRouterV2's on-chain checks:
 *  sum == 10000; treasuryBps needs a treasury asset; parentBurnBps needs a parent.
 *  `allowTreasury` is false at launch (treasuryAsset is address(0) there). */
export function validateFeeSplit(split: FeeSplit, opts: { parent?: Address; allowTreasury?: boolean } = {}): void {
  const buckets = [split.creatorBps, split.treasuryBps, split.buybackBps, split.parentBurnBps, split.rewardsBps];
  for (const v of buckets) {
    if (!Number.isInteger(v) || v < 0 || v > 10000) throw new SplitShapeError(`Each bucket must be an integer in [0,10000] (got ${v}).`);
  }
  const sum = buckets.reduce((a, b) => a + b, 0);
  if (sum !== 10000) throw new SplitShapeError(`Fee split must sum to 10000 bps (got ${sum}).`);
  if (split.treasuryBps > 0 && !opts.allowTreasury) {
    throw new SplitShapeError("treasuryBps must be 0 — the treasury fee bucket is disabled (treasuryAsset = address(0)).");
  }
  if (split.parentBurnBps > 0 && !opts.parent) {
    throw new ValidationError("parentBurnBps > 0 requires a `parent` token.");
  }
}

/** Replicates FeeRouterV2.scheduleSplit's asymmetric-delay rule:
 *  INSTANT iff the creator share is not raised and no other bucket is lowered;
 *  otherwise the change is subject to the 7-day delay. */
export function isInstantSplitChange(current: FeeSplit, next: FeeSplit): boolean {
  return (
    next.creatorBps <= current.creatorBps &&
    next.treasuryBps >= current.treasuryBps &&
    next.buybackBps >= current.buybackBps &&
    next.parentBurnBps >= current.parentBurnBps &&
    next.rewardsBps >= current.rewardsBps
  );
}

/** True when two splits are identical (nothing to schedule). */
export function splitsEqual(a: FeeSplit, b: FeeSplit): boolean {
  return a.creatorBps === b.creatorBps && a.treasuryBps === b.treasuryBps && a.buybackBps === b.buybackBps && a.parentBurnBps === b.parentBurnBps && a.rewardsBps === b.rewardsBps;
}

export const SPLIT_DELAY_SECONDS = 7n * 24n * 60n * 60n;
