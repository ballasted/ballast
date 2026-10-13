// Pure helpers behind the backing panel's freshness/sequencer display. Kept out
// of the React component so the core invariant — a priced asset stays valued
// even when the sequencer status is Unknown — is unit-testable without a DOM.

export type SequencerNoteKind = "none" | "unverifiable" | "untrusted";

/**
 * The note to show beside the backing figures, from BackingLens's
 * `sequencerStatus` (0 Unknown · 1 Up · 2 GracePeriod · 3 Down).
 *
 * Robinhood Chain (4663) publishes NO L2 sequencer uptime feed, so BackingLens
 * is constructed with address(0) and returns 0 (Unknown): we did NOT check it —
 * "unverifiable" (CLAUDE.md rule 10), and we must never imply it was checked.
 * Crucially, Unknown NEVER suppresses pricing — assets are still valued from
 * their own Chainlink feeds. Only Down/GracePeriod (when a feed IS set) mark
 * prices untrusted.
 */
export function sequencerNote(status: number): SequencerNoteKind {
  if (status === 2 || status === 3) return "untrusted";
  if (status === 1) return "none"; // checked and up — nothing to warn about
  return "unverifiable"; // 0 Unknown — no sequencer feed on this chain
}

type AssetLike = { priced: boolean };

/** Whether at least one treasury asset was priced from its feed — drives the
 *  "last updated" line vs the "No priced assets" fallback. Independent of the
 *  sequencer status: a priced asset stays priced when the sequencer is Unknown. */
export function hasPricedAssets(assets: readonly AssetLike[]): boolean {
  return assets.some((a) => a.priced);
}

/** The USD total we display. Comes straight from the lens; the sequencer status
 *  never zeroes it (rule 10). Named so the "Unknown still values" invariant is
 *  unit-testable. */
export function displayedTotalUsd(backing: { totalValueUsd: bigint }): bigint {
  return backing.totalValueUsd;
}
