# Phase 0 — Dune vs Ponder (analytics data source)

Decision record for `docs/Ballast-visual-upgrade` Phase 0. Investigated before
building anything analytics-related, as the spec requires.

## Findings

**1. Does Dune index chain 4663?** Yes. Robinhood Chain went live on Dune in
July 2026; Entropy Advisors shipped the first dashboards ("$55M chain TVL, 101
stock tokens"). The chain is queryable at `dune.com/blockchains/robinhood`.

**2. Which tables exist?** Dune exposes the standard raw layer for the chain —
`robinhood.logs`, `robinhood.transactions`, `robinhood.traces`, `robinhood.blocks`
— plus curated/spellbook tables for chain-wide context (tokens, transfers, and
DEX/bridge activity built by Dune and community wizards). What it does **not**
have is decoded tables for **our** contracts: `BallastFactory`, `ProjectTreasury`,
`BallastHook` are brand-new and unknown to Dune. Getting them decoded means
submitting each ABI for decoding, or hand-decoding raw logs in SQL — which is
exactly the work our Ponder indexer already does natively via the factory pattern.

**3. Free-tier API access?** Yes, but tight. The Analytics API is available on
the free plan with **2,500 credits/month** (overage billed $5 / 100 credits) and
100 MB storage; exports cost 20 credits/MB on free. Results are **materialized**
(batch), not live — Pons' own footer admits this: "Dune updated 4:09 PM, latest
complete day Jul 24 UTC." A continuously-loaded analytics page polling Dune would
burn the free credit budget fast and still show day-late numbers.

**4. What Dune does NOT cover that Ponder does:**
- **Live trade feed** — Dune is batch; Ponder streams from ~100ms blocks.
- **Per-token OHLC candles** — expressible in SQL but heavy and day-late.
- **Holder lists** — expensive query, not live.
- **Per-wallet position history** — batch only.
- **Our protocol figures** — total ballast, per-project backing, backing ratio:
  derived from *our* contracts, which Dune hasn't decoded.

## Recommendation — **Ponder only** for BALLAST figures; Dune as optional context

Every figure on the analytics page comes from **Ponder**, the single source of
truth. This is not a preference — the spec (§3.2) requires every figure to
reconcile with Discover and the token pages, which already read Ponder + chain.
Protocol totals must equal the sum of what Discover lists; a second, day-late
source (Dune) feeding the same tiles would produce exactly the two-sources-
disagree failure the spec calls worse than a missing number.

Dune stays useful for **chain-wide context we don't otherwise have** (e.g. total
Robinhood-Chain TVL, count of stock tokens) — but only as an explicitly separate,
clearly-attributed panel ("Source: Dune, chain-wide"), never mixed into a tile
that also has a Ponder value. Not wired now; noted as a future add.

**Net:** Dune does not save the Ponder work. Our differentiator (total ballast,
median backing ratio, ballasted share) is precisely what Dune cannot produce
without re-implementing our indexer in SQL. Build the analytics page on Ponder;
degrade to "data delayed" when the indexer lags (per §3.2), never to a Dune
fallback that would disagree.
