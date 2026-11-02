// ─────────────────────────────────────────────────────────────────────────────
// BALLAST Creator Fund — single source of truth for the campaign.
//
// Everything that decides eligibility, milestones, prize size, caps, the eligible
// quote assets, and the on-chain disclosure used for the prize deposit lives HERE,
// and ONLY here. The scanner (scripts/creator-fund/scan.ts), the public page
// (/app/creator-fund), the admin page, and the payout helper all import from this
// file so they can never drift apart.
//
// This module is deliberately dependency-light (viem types + keccak256 only, no
// `server-only`, no React, no Node fs) so it imports cleanly in BOTH the browser
// bundle and a plain `tsx` node script.
//
// COPY RULE (CLAUDE.md legal rules): nothing here — or anything rendered from it —
// may use "floor/guaranteed/protected/secured/safe/yield/insured/returns", and the
// prize must never be framed as a benefit to depositors or a claim on the treasury.
// The prize is a THIRD-PARTY deposit that becomes permanently locked (see
// PRIZE_DISCLOSURE below): it increases displayed backing, it is not redeemable.
// ─────────────────────────────────────────────────────────────────────────────
import { keccak256, toBytes, type Address } from "viem";

// ── Campaign timing ──────────────────────────────────────────────────────────
// CAMPAIGN_START is the unix second the announcement goes live. The human fills it
// via NEXT_PUBLIC_CREATOR_FUND_START (so both the browser and the scanner read the
// same value from env). 0 = "not announced yet": the page shows a pre-launch state
// and the scanner refuses to classify anyone as eligible (nothing can be "launched
// at or after" an unset start), rather than silently using block 0.
export const CAMPAIGN_START: number = Number(
  process.env.NEXT_PUBLIC_CREATOR_FUND_START ?? "0",
);

/** True once the human has set a real campaign start. */
export const isCampaignStarted = (now: number): boolean =>
  CAMPAIGN_START > 0 && now >= CAMPAIGN_START;

// ── Milestones & prize (campaign rules — the money) ──────────────────────────
export const MILESTONE_VOLUME_USD = 50_000; // cumulative swap volume, USD
export const MILESTONE_HOLDERS = 100; // distinct non-zero holders, after exclusions
export const MILESTONE_WINDOW_DAYS = 14; // measured from the token's launch block ts
export const MILESTONE_WINDOW_SECONDS = MILESTONE_WINDOW_DAYS * 24 * 60 * 60;

export const MAX_WINNERS = 10;
export const PRIZE_USD = 1_000;
export const TOTAL_CAP_USD = MAX_WINNERS * PRIZE_USD; // 10,000

// ── Eligible stock quote assets ──────────────────────────────────────────────
// A token is eligible only if at least one of its pools is quoted in one of these
// three stock tokens (WETH-only launches are NOT eligible). Addresses are the
// canonical Robinhood Stock Token addresses (CLAUDE.md rule 14 — allowlist by
// canonical contract address, never ticker). The scanner cross-checks each against
// AssetRegistry.isAllowed()/feedOf() at runtime; these constants only decide
// *eligibility*, never *trust*. Env (TOKEN_<TICKER>) overrides for a redeploy.
function envAddr(name: string, fallback: string): Address {
  const v = process.env[name];
  if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) return v as Address;
  return fallback as Address;
}

export type EligibleQuote = { ticker: "NVDA" | "SPY" | "SGOV"; address: Address };

export const ELIGIBLE_QUOTE_ASSETS: EligibleQuote[] = [
  { ticker: "NVDA", address: envAddr("TOKEN_NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC") },
  { ticker: "SPY", address: envAddr("TOKEN_SPY", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C") },
  { ticker: "SGOV", address: envAddr("TOKEN_SGOV", "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5") },
];

const ELIGIBLE_QUOTE_SET = new Set(ELIGIBLE_QUOTE_ASSETS.map((q) => q.address.toLowerCase()));

/** True if `asset` is one of the three eligible stock quote assets. */
export function isEligibleQuote(asset: Address | string | undefined | null): boolean {
  if (!asset) return false;
  return ELIGIBLE_QUOTE_SET.has(asset.toLowerCase());
}

/** The eligible-quote ticker for an address, or undefined. */
export function eligibleQuoteTicker(asset: Address | string): EligibleQuote["ticker"] | undefined {
  const m = ELIGIBLE_QUOTE_ASSETS.find((q) => q.address.toLowerCase() === asset.toLowerCase());
  return m?.ticker;
}

// ── Prize asset (what $1,000 is deposited as) ────────────────────────────────
// Default SGOV: a treasury-bill token, ~stable price and lowest volatility, so the
// USD value of the deposit stays close to $1,000 between when the scanner computes
// the amount and when the Safe signer actually submits. Per-winner overridable in
// confirmed-winners.json (`prizeAsset`). Must be one of the eligible quotes (all
// three are AssetRegistry-allowlisted, a hard requirement for proposeDeposit).
export const DEFAULT_PRIZE_TICKER: EligibleQuote["ticker"] = "SGOV";
export const DEFAULT_PRIZE_ASSET: Address = ELIGIBLE_QUOTE_ASSETS.find(
  (q) => q.ticker === DEFAULT_PRIZE_TICKER,
)!.address;

// ── Prize disclosure (for ProjectTreasury.proposeDeposit) ────────────────────
// proposeDeposit(asset, amount, disclosureVersion) requires a NON-ZERO bytes32
// disclosureVersion — the hash of the exact disclosure text the depositor (the
// Safe) confirmed, stored permanently on-chain. We hash a fixed, versioned string
// so the deposit is self-documenting and the version is reproducible/auditable.
// Bump the suffix (…v2) only if the text below ever changes.
export const PRIZE_DISCLOSURE_TEXT =
  "BALLAST Creator Fund prize deposit v1. This is a one-way, permanently-locked " +
  "third-party deposit into the project treasury. It confers no claim, redemption " +
  "right, or entitlement on anyone, including token holders and the project creator.";
export const PRIZE_DISCLOSURE_VERSION = keccak256(toBytes(PRIZE_DISCLOSURE_TEXT));

// The disclaimer that must render inside the campaign/leaderboard UI (CLAUDE.md:
// no returns framing; holders get no claim on the treasury).
export const CREATOR_FUND_DISCLAIMER =
  "Prize is deposited into the token's treasury. Holding a token gives no claim on its treasury.";

// ── Feature / gate flags ─────────────────────────────────────────────────────
// Public page visibility. The route always exists; when this is not "true" it
// renders an honest pre-launch state instead of a live leaderboard (same pattern
// as /app/vote and /app/buyback). Carries no secret, so NEXT_PUBLIC_ is correct.
export const isCreatorFundEnabled = process.env.NEXT_PUBLIC_CREATOR_FUND_ENABLED === "true";

// Admin review page gate. SERVER-ONLY (no NEXT_PUBLIC_): the admin view exposes
// manual-review flags and must never be reachable client-side. When this is not
// "true" the /app/creator-fund/admin route 404s.
export const isCreatorFundAdmin = process.env.CREATOR_FUND_ADMIN === "true";

// ── Shared data model (scanner output ⇄ page input) ──────────────────────────
export type TokenStatus =
  | "in_progress" // window still open, has not yet met both conditions
  | "qualified" // met both conditions within the window, clean
  | "expired" // window closed without meeting both conditions
  | "disqualified_candidate"; // met both but needs manual review (see `reviewNotes`)

export const STATUS_LABEL: Record<TokenStatus, string> = {
  in_progress: "In progress",
  qualified: "Qualified",
  expired: "Expired",
  disqualified_candidate: "Needs review",
};

/** A quote asset of a token's pool, with eligibility marked. */
export type QuoteAssetRef = {
  address: Address;
  symbol: string;
  eligible: boolean; // one of NVDA/SPY/SGOV
};

/** Public leaderboard entry — safe to ship to the browser. Contains no per-swap
 *  flag detail (that is admin-only); only the two aggregate volume figures. */
export type PublicTokenEntry = {
  token: Address;
  name: string;
  symbol: string;
  creator: Address;
  treasury: Address;
  factory: Address;
  quoteAssets: QuoteAssetRef[];
  launchBlock: number;
  launchTs: number; // unix secs (launch block timestamp)
  windowEndTs: number; // launchTs + 14d
  rawVolumeUsd: number;
  flaggedVolumeUsd: number; // volume attributed to flagged swaps
  volumeExcludingFlaggedUsd: number; // rawVolumeUsd − flaggedVolumeUsd
  holders: number; // non-zero holders after exclusions
  volumeMilestoneReachedTs: number | null;
  holdersMilestoneReachedTs: number | null;
  /** The later of the two milestone times — the ordering key for prizes. */
  secondMilestoneReachedTs: number | null;
  status: TokenStatus;
  /** 1-based rank among qualified tokens by secondMilestoneReachedTs (≤ MAX_WINNERS), else null. */
  rank: number | null;
  reviewNotes: string[]; // short, non-sensitive reasons (shown on admin; a subset is safe publicly)
  funded: FundedInfo | null;
  /** On-chain prize-deposit status (confirmed winners only); null otherwise. */
  payout?: PayoutStatus | null;
};

/**
 * On-chain status of a prize deposit the Safe proposed to a winner's treasury.
 * Derived from the treasury's DepositProposed/Accepted/Declined/Reclaimed events
 * (depositor = the Safe), so the UI reflects reality, not a hand-edited flag.
 *   proposed  — proposeDeposit landed, awaiting the creator's acceptDeposit
 *   accepted  — creator accepted; funds permanently locked (the "Funded" state)
 *   expired   — 7-day window passed with no acceptance (reclaimable by the depositor)
 *   reclaimed — funds returned to the Safe after expiry
 *   declined  — creator declined; funds returned to the Safe
 */
export type PayoutState = "none" | "proposed" | "accepted" | "expired" | "reclaimed" | "declined";

export type PayoutStatus = {
  state: PayoutState;
  proposalId?: number;
  asset?: Address;
  amount?: string; // raw units
  proposedAt?: number; // unix secs
  acceptWindowEnds?: number; // proposedAt + 7d
  proposedTx?: string;
  resolvedTx?: string; // accepted/declined/reclaimed tx
};

export const PAYOUT_STATE_LABEL: Record<PayoutState, string> = {
  none: "—",
  proposed: "Proposed · awaiting creator",
  accepted: "Accepted · funded",
  expired: "Expired · reclaimable",
  reclaimed: "Reclaimed to Safe",
  declined: "Declined",
};

export type FundedInfo = {
  txHash: string; // Safe execution tx that deposited the prize
  asset: Address;
  amount: string; // raw units (string to avoid bigint JSON loss)
  amountUsd: number;
  priceUsd: number; // prize asset price used
  at: number; // unix secs of the deposit
};

/** A single swap flagged for manual review (admin-only). */
export type FlaggedSwap = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTs: number;
  trader: Address;
  side: "buy" | "sell";
  usd: number;
  reasons: FlagReason[];
};

export type FlagReason =
  | "trader_is_creator"
  | "trader_is_team_recipient"
  | "trader_is_treasury"
  | "trader_funded_by_creator"
  | "wash_loop"; // same wallet buy/sell loop in a short window

export const FLAG_REASON_LABEL: Record<FlagReason, string> = {
  trader_is_creator: "trader = creator",
  trader_is_team_recipient: "trader = team-split recipient",
  trader_is_treasury: "trader = treasury",
  trader_funded_by_creator: "wallet funded by creator in-window",
  wash_loop: "wash pattern (rapid buy/sell loop)",
};

/** A holder flagged as part of a same-source funding cluster (admin-only). */
export type FlaggedHolder = {
  holder: Address;
  balance: string; // raw units
  reason: "cluster_same_source";
  fundedBy: Address; // the shared source wallet
  clusterSize: number;
};

/** Admin entry — public entry plus the per-item flag detail for manual review. */
export type AdminTokenEntry = PublicTokenEntry & {
  flaggedSwaps: FlaggedSwap[];
  flaggedHolders: FlaggedHolder[];
};

export type LeaderboardMeta = {
  generatedAt: number; // unix secs the scan finished
  campaignStart: number;
  lastScannedBlock: number;
};

export type PublicLeaderboard = { meta: LeaderboardMeta; tokens: PublicTokenEntry[] };
export type AdminLeaderboard = { meta: LeaderboardMeta; tokens: AdminTokenEntry[] };

/** A human-committed confirmed winner (scripts/creator-fund/confirmed-winners.json). */
export type ConfirmedWinner = {
  token: Address;
  /** Optional override of the prize asset for this winner (default SGOV). */
  prizeAsset?: Address;
  /** Set AFTER the Safe tx is signed + executed, so the UI shows a Funded badge. */
  funded?: FundedInfo;
  note?: string;
};

// ── Pure helpers (shared by scanner + pages; unit-tested) ────────────────────

/** Progress toward a target as a 0–100 percentage (clamped). */
export function progressPct(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, (value / target) * 100));
}

/** Seconds remaining in a token's 14-day window, clamped at 0. */
export function windowSecondsLeft(launchTs: number, now: number): number {
  return Math.max(0, launchTs + MILESTONE_WINDOW_SECONDS - now);
}

/** Whole days left in the window (rounded up), clamped at 0. */
export function windowDaysLeft(launchTs: number, now: number): number {
  return Math.ceil(windowSecondsLeft(launchTs, now) / (24 * 60 * 60));
}

/** True if `ts` falls within [launchTs, launchTs + 14d]. */
export function withinWindow(launchTs: number, ts: number): boolean {
  return ts >= launchTs && ts <= launchTs + MILESTONE_WINDOW_SECONDS;
}

/** Remaining prize spots: cap minus confirmed winners. */
export function remainingSpots(confirmedCount: number): number {
  return Math.max(0, MAX_WINNERS - confirmedCount);
}

/**
 * Compute status + the ordering milestone time from a token's measured figures.
 * `volumeMilestoneReachedTs` / `holdersMilestoneReachedTs` are the first in-window
 * times each threshold was crossed (null = never crossed in-window). A token is:
 *   • in_progress  — window open, not both crossed
 *   • expired      — window closed, not both crossed
 *   • qualified    — both crossed in-window AND clean (excl-flagged vol ≥ target,
 *                    holders ≥ target, creator not a duplicate)
 *   • disqualified_candidate — both crossed but a review reason applies
 * Returns the status, the second-milestone time, and any review notes.
 */
export function computeStatus(args: {
  now: number;
  launchTs: number;
  volumeMilestoneReachedTs: number | null;
  holdersMilestoneReachedTs: number | null;
  volumeExcludingFlaggedUsd: number;
  holders: number;
  creatorHasEarlierQualifier: boolean;
}): { status: TokenStatus; secondMilestoneReachedTs: number | null; reviewNotes: string[] } {
  const {
    now,
    launchTs,
    volumeMilestoneReachedTs,
    holdersMilestoneReachedTs,
    volumeExcludingFlaggedUsd,
    holders,
    creatorHasEarlierQualifier,
  } = args;

  const bothReached = volumeMilestoneReachedTs !== null && holdersMilestoneReachedTs !== null;
  const secondMilestoneReachedTs = bothReached
    ? Math.max(volumeMilestoneReachedTs!, holdersMilestoneReachedTs!)
    : null;
  const windowOpen = now <= launchTs + MILESTONE_WINDOW_SECONDS;
  const reviewNotes: string[] = [];

  if (!bothReached) {
    return { status: windowOpen ? "in_progress" : "expired", secondMilestoneReachedTs: null, reviewNotes };
  }

  // Both milestones crossed in-window. Decide clean vs needs-review.
  if (volumeExcludingFlaggedUsd < MILESTONE_VOLUME_USD) {
    reviewNotes.push("Meets $50k only with flagged volume included");
  }
  if (holders < MILESTONE_HOLDERS) {
    // Should not normally happen (milestone time is derived from the clean holder
    // count), but guard anyway so a later recount can't silently qualify.
    reviewNotes.push("Holder count fell below 100 after exclusions");
  }
  if (creatorHasEarlierQualifier) {
    reviewNotes.push("Creator already has an earlier qualifying token (one entry per creator)");
  }

  const status: TokenStatus = reviewNotes.length === 0 ? "qualified" : "disqualified_candidate";
  return { status, secondMilestoneReachedTs, reviewNotes };
}
