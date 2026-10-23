# Megabuild — running DECISIONS log

Conservative defaults taken where the build prompt didn't specify. Compiled into
the final report. One section per phase.

## Orchestration reality (discovered at start)
Phases 0,1,2,4,5 were already committed on their own branches by parallel agents
before this run began (verified via `git log --all`):
- Phase 0 → `chore/hide-test-tokens` (a4f7fae, 6 files)
- Phase 1 → `feat/sdk` (7d4b423, 31 files, ~12.2k LOC)
- Phase 2 → `feat/tg-bot` (2d4c6e9, 9 files)
- Phase 4 → `feat/launch-templates` (6b12ad7, 4 files)
- Phase 5 → `feat/share-cards` (f20b032, 6 files)

**Decision:** Do NOT duplicate those branches. This run (1) finishes Phase 3
(`feat/roundups`, contracts were written but uncommitted), (2) builds Phase 6
(`feat/creator-splitter`, no branch existed), (3) builds Phase 7
(`feat/gen5-limit-orders`, no branch existed). Phases 0-2,4-5 are verified and
reported, not rebuilt. `worktree-agent-*` branches are stale (unrelated fix
commit); `growth/*` is a separate earlier initiative.

## Phase 3 — round-ups + burn-vote
- **RoundupRouter stays adapter-orchestrated**, not a V4Router monolith.
  BasketZap.swapBasket delivers stock to the launch creator/treasury, not an
  arbitrary wallet, so it can't be called directly to deliver a round-up to the
  trader. Reproducing its ~300-line V4Router routing inside RoundupRouter can't
  be fork-verified in this environment, so shipping it untested would add risk
  with no proven value. The safety-critical orchestration (cap, split, try/catch
  refund, no-stuck-funds, reentrancy) is the part that matters and it is fully
  unit-tested. The routing adapters (IStockBuyer, IMainSwapRouter) are the gating
  pre-mainnet work, fork-tested + audited by a human. See docs/security/roundups.md.
- **Deploy:** DeployRoundups.s.sol deploys BurnVote now (self-contained); it
  constructs RoundupRouter only when adapter env addresses are supplied, else
  skips with a console note. Dry-run / keystore only.
- **"Routable" stock gate:** on-chain contracts enforce AssetRegistry.isAllowed
  only. Routability depends on the off-chain routing tables, enforced at execution
  (adapter reverts → caught → refund). The UI stock picker only lists routable
  stocks. BurnVote checks allowlist only; routability is a UI concern.
- **BurnVote factory set is immutable**; the deploy script seeds the current
  BallastFactory and leaves a marked spot for the human to append prior factories.
