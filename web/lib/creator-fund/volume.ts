// ─────────────────────────────────────────────────────────────────────────────
// Creator Fund — volume aggregation. PURE, unit-tested.
//
// Volume is measured from PoolManager Swap events on the token's Ballast pools (all
// of its quote pools), each swap valued in USD at its block (see pricing.ts). The
// $50k milestone is the first in-window moment cumulative RAW volume crosses the
// threshold; we also report flagged volume and volume-excluding-flagged so a wash /
// self-dealing pattern can't silently win the money.
// ─────────────────────────────────────────────────────────────────────────────
import type { Address } from "viem";
import { classifySwap } from "../tg/swapDirection";
import { MILESTONE_VOLUME_USD, withinWindow } from "../creatorFund";
import { usdOfQuote, type QuoteFeed } from "./pricing";
import { swapKey, type RawSwap } from "./wash";

/** A decoded PoolManager Swap log (the fields we use), before pricing. */
export type DecodedSwap = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTs: number;
  trader: Address; // resolved EOA (tx.from), falling back to event sender
  token: Address; // the launched token
  quote: Address; // the pool's quote asset
  amount0: bigint;
  amount1: bigint;
};

/**
 * Pure: turn a decoded swap into a priced RawSwap. `priceUsd` is the quote asset's
 * USD price at this swap's block (undefined → unpriced → usd=null, never 0).
 */
export function rawSwapFromDecoded(d: DecodedSwap, feed: QuoteFeed | undefined, priceUsd: number | undefined): RawSwap {
  const c = classifySwap(d.token, d.quote, d.amount0, d.amount1);
  const usd =
    feed && priceUsd !== undefined ? usdOfQuote(c.quoteAbs, feed.tokenDecimals, priceUsd) : null;
  return {
    txHash: d.txHash,
    logIndex: d.logIndex,
    blockNumber: d.blockNumber,
    blockTs: d.blockTs,
    trader: d.trader,
    side: c.side,
    usd,
  };
}

export type VolumeResult = {
  rawVolumeUsd: number; // cumulative in-window USD across all (priced) swaps
  flaggedVolumeUsd: number; // USD attributed to flagged swaps
  volumeExcludingFlaggedUsd: number;
  volumeMilestoneReachedTs: number | null; // first in-window ts raw crosses $50k
  unpricedCount: number; // swaps with no feed (surfaced, not counted as $0)
};

/**
 * Pure: aggregate in-window volume and find the milestone-crossing time. `swaps` may
 * contain out-of-window entries — they are filtered against [launchTs, +14d]. Order
 * of input does not matter (we sort by ts, then logIndex).
 */
export function aggregateVolume(swaps: RawSwap[], launchTs: number, flaggedKeys: Set<string>): VolumeResult {
  const inWindow = swaps.filter((s) => withinWindow(launchTs, s.blockTs));
  const sorted = [...inWindow].sort((a, b) => a.blockTs - b.blockTs || a.logIndex - b.logIndex);

  let rawVolumeUsd = 0;
  let flaggedVolumeUsd = 0;
  let unpricedCount = 0;
  let volumeMilestoneReachedTs: number | null = null;

  for (const s of sorted) {
    if (s.usd === null) {
      unpricedCount++;
      continue;
    }
    rawVolumeUsd += s.usd;
    if (flaggedKeys.has(swapKey(s))) flaggedVolumeUsd += s.usd;
    if (volumeMilestoneReachedTs === null && rawVolumeUsd >= MILESTONE_VOLUME_USD) {
      volumeMilestoneReachedTs = s.blockTs;
    }
  }

  return {
    rawVolumeUsd,
    flaggedVolumeUsd,
    volumeExcludingFlaggedUsd: Math.max(0, rawVolumeUsd - flaggedVolumeUsd),
    volumeMilestoneReachedTs,
    unpricedCount,
  };
}
