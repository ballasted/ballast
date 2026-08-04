// Live-refresh policy for on-chain reads (spec Part 1.2).
//
// The spec: on-chain reads refresh every ~12s, immediately after any transaction
// the user sends, and PAUSE when the tab is hidden (don't burn RPC on background
// tabs), resuming on focus.
//
// This is expressed with React-Query options rather than a bespoke poller:
//   • refetchInterval: ON_CHAIN_REFRESH_MS  → the 12s cadence.
//   • React-Query's default `refetchIntervalInBackground: false` → the interval
//     stops while the document is hidden (the pause), and the default
//     `refetchOnWindowFocus: true` → it resumes (and refetches once) on focus.
//   • Immediate post-tx refresh is a manual invalidate — see useInvalidateChainReads.
//
// Applied to the market-moving on-chain hooks (useProjects, useBacking). Config-ish
// reads that don't change per block (fee split, opening tick, asset registry) keep
// the default mount/focus cadence — polling them every 12s would be pure waste.

export const ON_CHAIN_REFRESH_MS = 12_000;

/** React-Query options for a live on-chain read: the 12s cadence plus the caller's
 *  `enabled` gate. Spread into a wagmi `query` field. */
export function liveQuery(enabled = true) {
  return { enabled, refetchInterval: ON_CHAIN_REFRESH_MS } as const;
}
