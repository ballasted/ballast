// ─────────────────────────────────────────────────────────────────────────────
// Creator Fund — swap flagging (self-dealing + wash patterns). PURE, unit-tested.
//
// These flags NEVER remove a swap from the raw total. The scanner reports BOTH
// "raw volume" and "volume excluding flagged" so the human reviewer decides what
// counts (campaign rules: "Flag but still show for my manual review"). Flagging is
// deliberately conservative/explainable — every flag has a named reason.
// ─────────────────────────────────────────────────────────────────────────────
import type { Address } from "viem";
import type { FlagReason, FlaggedSwap } from "../creatorFund";

export type RawSwap = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTs: number; // unix secs
  trader: Address; // resolved EOA (tx.from), lowercased by callers where noted
  side: "buy" | "sell";
  usd: number | null; // null = unpriced (no feed); excluded from USD totals
};

export type FlagContext = {
  creator: Address;
  treasury: Address;
  /** Lowercased team-split recipient addresses (creator's fee splitter payees). */
  teamRecipients: Set<string>;
  /** Lowercased wallets funded by the creator within the campaign window. */
  creatorFundedWallets: Set<string>;
};

/** Default "short window" for a wash buy/sell loop by the same wallet: 1 hour. */
export const WASH_WINDOW_SECONDS = 60 * 60;

const lc = (a: Address | string): string => a.toLowerCase();

/** Identity-based flags for a trader (not time-based). */
export function identityFlags(trader: Address, ctx: FlagContext): FlagReason[] {
  const t = lc(trader);
  const reasons: FlagReason[] = [];
  if (t === lc(ctx.creator)) reasons.push("trader_is_creator");
  if (t === lc(ctx.treasury)) reasons.push("trader_is_treasury");
  if (ctx.teamRecipients.has(t)) reasons.push("trader_is_team_recipient");
  if (ctx.creatorFundedWallets.has(t)) reasons.push("trader_funded_by_creator");
  return reasons;
}

/**
 * Keys ("txHash|logIndex") of swaps that are part of a wash loop: the same wallet
 * doing an opposite-side swap within `windowSeconds` of another. Both legs of each
 * detected loop are flagged. O(n·k) over each wallet's in-window neighbours.
 */
export function washLoopKeys(swaps: RawSwap[], windowSeconds = WASH_WINDOW_SECONDS): Set<string> {
  const flagged = new Set<string>();
  const byTrader = new Map<string, RawSwap[]>();
  for (const s of swaps) {
    const t = lc(s.trader);
    const arr = byTrader.get(t);
    if (arr) arr.push(s);
    else byTrader.set(t, [s]);
  }
  for (const arr of byTrader.values()) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => a.blockTs - b.blockTs || a.logIndex - b.logIndex);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if (b.blockTs - a.blockTs > windowSeconds) break; // sorted → no later one qualifies
        if (b.side !== a.side) {
          flagged.add(`${a.txHash}|${a.logIndex}`);
          flagged.add(`${b.txHash}|${b.logIndex}`);
        }
      }
    }
  }
  return flagged;
}

/** Stable key for a swap. */
export const swapKey = (s: { txHash: string; logIndex: number }): string => `${s.txHash}|${s.logIndex}`;

/**
 * Compute all flags for a token's swaps. Returns the FlaggedSwap[] (only swaps with
 * ≥1 reason) and a Set of their keys (for excluding-flagged volume math).
 */
export function computeSwapFlags(
  swaps: RawSwap[],
  ctx: FlagContext,
  windowSeconds = WASH_WINDOW_SECONDS,
): { flaggedSwaps: FlaggedSwap[]; flaggedKeys: Set<string> } {
  const washKeys = washLoopKeys(swaps, windowSeconds);
  const flaggedSwaps: FlaggedSwap[] = [];
  const flaggedKeys = new Set<string>();

  for (const s of swaps) {
    const reasons = identityFlags(s.trader, ctx);
    if (washKeys.has(swapKey(s))) reasons.push("wash_loop");
    if (reasons.length === 0) continue;
    flaggedKeys.add(swapKey(s));
    flaggedSwaps.push({
      txHash: s.txHash,
      logIndex: s.logIndex,
      blockNumber: s.blockNumber,
      blockTs: s.blockTs,
      trader: s.trader,
      side: s.side,
      usd: s.usd ?? 0,
      reasons,
    });
  }
  // Newest first for review.
  flaggedSwaps.sort((a, b) => b.blockTs - a.blockTs);
  return { flaggedSwaps, flaggedKeys };
}
