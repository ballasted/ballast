# Round-ups + burn-vote — design & security

Two ownerless, immutable contracts that let a trader optionally buy a small
amount of an allowlisted stock token into **their own wallet** alongside a
normal Ballast swap, and let a token's community signal which stock should be
the suggested default. Neither contract holds funds between calls, neither has
an owner or admin, and **Ballast takes 0% of either flow**.

- `contracts/src/RoundupRouter.sol` — one-tx swap + optional round-up leg.
- `contracts/src/BurnVote.sol` — burn-to-vote for a community's default stock.

Referenced by `RoundupRouter.sol`'s NatSpec. Read this before review/audit.

---

## Why these do not break the hard rules

The round-up is a **trader buying a stock token for themselves**, in the same
transaction as their swap. It is not a Ballast product feature attached to
holding, depositing, or backing. Mapping to CLAUDE.md hard rules:

- **No reward for depositing ballast (rule 3).** The stock goes to the trader's
  own wallet. It is never deposited into any treasury, never credited to the
  project, and confers nothing on the token. It is a side-purchase, not a
  benefit for holding or backing.
- **No platform fee on treasury (rules 3–4).** `RoundupRouter` takes nothing.
  The only fee charged is the hook fee on the *main* swap, which applies exactly
  as it does today — the round-up leg adds no Ballast fee. `MAX_ROUNDUP_BPS` caps
  the round-up itself at 5% of the trade, and that 5% is spent entirely on the
  trader's stock, not retained.
- **No redemption/claim implied (rule 2).** Nothing here touches treasury
  assets or creates any claim on them. `BurnVote` burns are sent straight to
  `0x…dEaD` and are gone; a burn buys no entitlement, refund, or payout.
- **Vote controls no funds (trust model).** `BurnVote` only computes a
  *suggested default stock* for a token's community. It moves no money, cannot
  redirect a swap, and cannot touch a treasury. The worst outcome of a
  manipulated vote is a wrong *default suggestion* in the UI, which the trader
  overrides per-trade.
- **Language.** Copy/strings/variable names avoid the banned vocabulary. A
  round-up is described as "buy a little <TICKER> for yourself," never as a
  return, benefit, or protection.

---

## RoundupRouter — design

One transaction = the trader's normal Ballast swap (BUY or SELL) + an optional
round-up leg that buys an allowlisted stock and delivers it to the trader.

### BUY (`buyWithRoundup`)

`msg.value = mainEth + roundupEth`, where the round-up is **extra on top** of the
swap amount: `roundupEth = total * bps / (BPS + bps)`. The round-up leg runs
first under `try/catch`; on any routing failure its ETH is refunded to the
trader and the main swap still executes. The stock is delivered straight to the
trader by the adapter.

### SELL (`sellWithRoundup`)

Pulls the token from the trader (`safeTransferFrom` + scoped `forceApprove`,
reset to 0 after), sells it for ETH into this contract, then spends a **share of
the proceeds** (`ethOut * bps / BPS`) on the round-up. On a round-up failure the
ETH folds back into the trader's payout. The remaining ETH is sent to the trader.

### Invariants

- **No stuck funds.** Every path ends in `_sweepDust()`, which returns any
  residual ETH to the trader. Tests assert `address(rr).balance == 0` after
  every flow. `receive()` exists only to accept adapter refunds mid-call.
- **CEI + `nonReentrant`.** The round-up leg is `try/catch`; a reentrant adapter
  is blocked by the guard, the leg is caught as a failure (refunded), and the
  main swap still completes — proven by `test_Reentrancy`.
- **Allowlist is a hard gate, routing failure is soft.** An un-allowlisted stock
  **reverts** (`StockNotAllowed`) — a misconfigured call must fail loudly. A
  routing failure **refunds** — a transient liquidity problem must not brick the
  trade. `isAllowed` is read live from the AssetRegistry (never hardcoded).
- **Cap.** `roundupBps` is bounded by `MAX_ROUNDUP_BPS = 500` (5%). Checked in
  both `_roundupOnTop` and `_roundupShareOfInput`.

### Security status — NOT YET DEPLOYABLE

The orchestration logic (cap, split, try/catch refund, no-stuck-funds, events)
is unit-tested deterministically against mocks (`test/RoundupRouter.t.sol`, 9
tests). **The injected adapters are not built yet.**

`RoundupRouter` never reimplements routing. It delegates to two injected,
immutable adapters supplied at construction:

- `IMainSwapRouter` — the trader's main Ballast swap (the forked UniversalRouter
  wrapper / `BallastRouterV2`, or a thin adapter over it).
- `IStockBuyer` — ETH→stock, delivering to the trader. Must wrap the **same**
  Fables/Ramses hop config `BasketZap`/`BallastRouterV2` already use (read-only
  reuse — see `docs/BASKET_DISCOVERY.md`), refund unspent ETH, and revert on
  failure so the `try/catch` can refund.

**Before mainnet, the adapters MUST be:**
1. Implemented as thin wrappers over the already-verified routing config (reuse
   the exact `fablesHops`/`ramsesRoutes` tables verbatim, do not re-derive —
   same rule as `DeployBasketZap.s.sol`).
2. Fork-tested against live pools (the main swap is already proven on-chain; the
   round-up leg is not — mirror `BasketZapFork.t.sol`).
3. Audited for the ETH-handling + delivery/refund contract above.

Until then, **do not** write a `DeployRoundupRouter.s.sol` with placeholder
adapter addresses. The deploy is blocked on the adapters, by design.

---

## BurnVote — design

Burn-to-vote for a token community's **suggested default** round-up stock.
Weekly epochs anchored to Monday 00:00 UTC (`EPOCH_GENESIS = 2024-01-01`, a
Monday; `EPOCH_LENGTH = 7 days`).

- **Vote = burn.** `vote(token, stock, amount)` sends `amount` of `token` to
  `0x…dEaD` via `safeTransferFrom` and credits `amount` votes to `stock` in the
  current epoch. Burns are irreversible and confer nothing.
- **Eligibility.** `token` must be Ballast-launched (`launchIdOf != 0` on any
  constructor-set factory, checked with per-factory `try/catch` so a factory
  predating `launchIdOf` is simply skipped). `stock` must be allowlisted.
  `stock == token` reverts (`SelfVote`).
- **Winner = unique strict maximum.** A tie or an empty epoch produces no
  winner and leaves the prior default unchanged (`_epochWinner` returns
  `address(0)`).
- **Lazy + gas-bounded resolution.** `defaultStock(token)` is correct even if
  `finalize()` is never called — it walks unresolved *completed* voted epochs
  newest-first and returns the first decisive winner. `finalize(token)` folds
  completed epochs into stored state to bound the view's gas after long
  inactivity; it is permissionless and idempotent. Proven equivalent by
  `test_FinalizeMatchesLazyView` and `test_LongGapThenFinalize`.

### Invariants

- **No funds held, no admin.** The contract never holds `token` (burns go
  straight to dead); no owner, no upgradeability, immutable factory set.
- **CEI + `nonReentrant`.** Vote is recorded before the `transferFrom`
  interaction; a reentrant token is blocked (`test_ReentrancyGuard`).
- **Bounded loops.** Per-epoch work is bounded by the number of *distinct stocks
  voted that epoch*, itself bounded by the allowlist size.

### Factory coverage — ALL generations

`vote()` recognises a token via `launchIdOf` on every factory in the immutable
constructor set, and `DeployRoundups.buildFactories()` now seeds **all four
BallastFactory generations** (gen-1..4), verified live on 4663 — each implements
`launchIdOf` (returns 0 for a non-launch, never reverts) and each has live
launches. FeeRouter v1/v2 launches and Safe launches all call
`BallastFactory.launch` on one of these four, so their tokens carry a `launchIdOf`
there and need no separate entry. A new public view `isVotableToken(token)`
exposes the same gate (for the UI and for direct test coverage). A fork test
(`test/BurnVoteFork.t.sol::test_Fork_RecognisesAllFactoryGenerations`) asserts one
real token from each generation is votable; a unit test
(`test_RecognisesTokenFromAnyFactory`) proves the loop scans past the first factory.

### Security status — DEPLOYABLE

`BurnVote` is self-contained: it needs only the live AssetRegistry and the live
`BallastFactory` set (all already deployed). 15 unit + 4 fork tests pass
(`test/BurnVote.t.sol`, `test/BurnVoteFork.t.sol`), including adversarial cases
(non-Ballast token, stock not allowed, self-vote, zero amount, reentrancy), the
full winner/tie/carry-over/long-gap matrix, and multi-factory recognition. See
`contracts/script/DeployRoundups.s.sol`.

### Dependency on AssetRegistry (read this with docs/ownership-migration.md)

`BurnVote` trusts `AssetRegistry.isAllowed(stock)` to gate which stock a vote may
name. **If the AssetRegistry is compromised, BurnVote is still fund-safe** — it
holds nothing, moves nothing, and burns go straight to the dead address; the only
achievable harm is that an attacker who can allowlist a junk "stock" could make it
*win a vote and become the suggested default round-up*. That is a UI suggestion,
not an action: the trader confirms the stock per trade and `RoundupRouter`
re-checks `isAllowed` on-chain at execution time.

This is NOT hypothetical today: the live `AssetRegistry`
(`0x427764d0d19aB765c35A41A5aa4771580307dA81`) is **currently owned by the
compromised EOA `0xA277…37D1`** (see docs/ownership-migration.md). The same
registry is the allowlist `RoundupRouter`'s stock leg trusts to decide what it
will buy — so a compromised registry is a materially bigger problem for the
round-up *purchase* path than for the vote. **Migrate AssetRegistry ownership to
the Safe (Step 2) before relying on round-ups or votes in production.**

---

## SDK wiring (Phase 3)

`packages/sdk` reserves `buyWithRoundup` and `vote` as Phase-3 extension points.
They currently throw `"… not wired into the SDK yet."` by design — wiring them
is gated on the `RoundupRouter` adapters above being built, fork-tested, and
audited, and on `RoundupRouter`/`BurnVote` being deployed and address-resolved
from the registry (never hardcoded per CLAUDE.md conventions). `BurnVote`'s
`vote` can be wired as soon as `BurnVote` is deployed; `buyWithRoundup` waits on
the full adapter path.
