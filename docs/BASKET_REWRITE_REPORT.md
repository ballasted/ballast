# Stock Basket — rewrite report (PR #41, `feat/stock-basket`)

Response to the two blockers. **No broadcasts were made; nothing was deployed.**
All on-chain work was read-only (`cast`/`forge script` dry-runs and fork tests
against `RH_RPC_URL_PAID`).

---

## 1. The new route table

Full detail + method in `docs/BASKET_DISCOVERY.md` §2. Probed read-only via
`contracts/script/probe/QuoteBasketRoutes.s.sol` against live mainnet
(2026-10-13, ETH/USD $2,533.01). **Routable = ≤3% impact at 0.1 ETH vs
Chainlink.** Impact measured on the **Ramses** venue (the one that reliably
quotes off-chain; see the Fables caveat below).

| Ticker | Ramses route | impact @0.1 ETH | Routable? |
|---|---|---|---|
| SGOV | WETH→USDG→SGOV | 0.04% | ✅ |
| AAPL | WETH→USDG→AAPL | 0.18% | ✅ |
| GOOGL | WETH→USDG→GOOGL | 0.15% | ✅ |
| NVDA | WETH→NVDA (direct) | 0.22% | ✅ |
| SPY | WETH→SPY (direct) | 0.24% | ✅ |
| PLTR | WETH→USDG→PLTR | 0.56% | ✅ |
| CRCL | WETH→USDG→CRCL | 0.99% | ✅ |
| QQQ | WETH→QQQ (direct) | 56.7% | ❌ small-ticket only (1.5% @0.01) |
| MSTR | WETH→USDG→MSTR | 39.1% | ❌ small-ticket only (0.1% @0.01) |
| TSLA | WETH→USDG→TSLA | 83.6% | ❌ small-ticket only (2.3% @0.01) |
| COIN | WETH→USDG→COIN | 82.5% | ❌ |
| AMZN | WETH→USDG→AMZN | 90.9% | ❌ |
| META | WETH→META (direct) | dead (0 out) | ❌ pool floored |
| MSFT | WETH→USDG→MSFT | ~99% | ❌ pool dead |
| AMD | WETH→USDG→AMD | ~99% | ❌ pool dead (no Fables route either) |
| ORCL | WETH→USDG→ORCL | ~99% | ❌ pool dead (no Fables route either) |

**7 of 16 routable: SGOV, AAPL, GOOGL, NVDA, SPY, PLTR, CRCL** (all stay ≤3% at
the full 1 ETH size too). The frontend route table
(`web/lib/basketRoutes.ts`) now ships with exactly these 7 marked routable.

**Fables caveat (honest):** every Fables `quoteExactInput` in the probe returned
0 — uniformly, including the shared deep ETH/USDG entry hop — which points at
the native-ETH multi-hop path reverting inside the fork's V4Quoter rather than
real zero liquidity (the same Fables routes execute in `BallastRouterV2`'s own
fork suite). So the table above is the conservative Ramses-only floor; Fables
(the contract's preferred venue, attempted per-call by the live frontend with
automatic Ramses fallback) can only ADD routable assets at small tickets, never
subtract. A human with a working off-chain Fables quote path should re-run the
probe to potentially widen the set (candidates: QQQ/MSTR/TSLA, which are
small-ticket-fine on Ramses and Fables-deep per the deploy note).

---

## 2. Chosen router, and why

**`BasketZap` now inherits v4-periphery's `V4Router` and executes each leg
through `poolManager.unlock()` (Fables) or a direct Uniswap-v3-style callback
(Ramses) — NOT the external UniversalRouter.** It is the identical mechanism
`BallastRouterV2` (live, ownerless, routes fixed) already uses; BasketZap reuses
that router's exact verified `fablesHops`/`ramsesRoutes` tables.

Why not the UniversalRouter (the old design):
- **Ramses v3 pools are unreachable through it** — its V3 path is bound to
  Uniswap's own factory/init-code-hash. Ramses is where most of the real
  stock-token liquidity is.
- **The Fables routes are multi-hop (ETH→USDG→stock), not the single-hop
  WETH→stock** the old `BasketZap` assumed. No WETH/<stock> pool exists at all —
  that's why the previous discovery concluded "zero routable pools."
- Routes are now selected by **index into fixed construction-time tables**, not
  caller-supplied PoolKeys — strictly safer: a bad index can only fail to chain
  (`BadHopChain`), never reach an unintended pool.

Per the brief's "ALSO": the **BasketZap constructor changed** accordingly, from
`(factory, registry, weth, universalRouter, permit2)` to
`(factory, registry, IPoolManager, weth, FablesHop[], RamsesRoute[])`.
`DeployBasketZap.s.sol` bakes in the same tables as `DeployBallastRouterV2.s.sol`
(index-for-index identical, diffable). Fixed before anyone deploys — see
`docs/DECISIONS.md` §6.

**`BallastRouterV2` as the leg executor was considered** and is effectively what
happened: rather than call the live `BallastRouterV2` (whose buy path is
hardcoded to continue into a Ballast *hook* pool as leg 2 — not what a basket
leg wants, it must stop at the stock token), BasketZap re-implements that
router's proven Fables/Ramses mechanism directly and stops at the stock token,
forwarding it to the creator.

---

## 3. The final flow and its signature count

`deposit()` on `ProjectTreasury` is `onlyCreator` (`msg.sender == creator`,
immutable; re-confirmed on-chain — `launches(2)` creator matches). No contract
can deposit on the creator's behalf; the `proposeDeposit`/`acceptDeposit`
on-behalf path routes to the *permanently-locked* bucket and still needs a
creator signature, so it's strictly worse (full analysis: `docs/DECISIONS.md`
§7). Therefore:

- **Plain-EOA creator:** `1` signature for `BasketZap.swapBasket()` (all N legs
  swap atomically, outputs land in the creator's wallet) + `2` per asset
  (`approve` + `deposit`), because only the creator's EOA can call `deposit()`.
  - **1 asset → 3 signatures.  6 assets → 13 signatures.**
- **Smart-account creator (Safe / EIP-7702):** the whole thing — swap + all
  approves + all deposits — is **1 atomic batched signature** (the account *is*
  the creator). Launches 0 and 1 on the current factory are Safe-created, so
  this path is available for them today.

Atomic single-action is **impossible for a plain-EOA creator without changing
gen-4 `ProjectTreasury`** (forbidden). This is stated plainly, not worked
around.

---

## 4. Does all-or-nothing hold?

- **Within the swap: yes.** Any leg failing both venues, or undershooting its
  own `minOut`, reverts the entire `swapBasket` — including legs already
  swapped (proven by `test_fork_revertsAllVenuesFailed…` and the unit
  `test_revert_minOutNotMet`/`failingLeg` paths).
- **Within a smart-account batch: yes** (one atomic tx).
- **Across the plain-EOA `swap → approve → deposit` sequence: NO** — those are
  separate transactions. A wallet that dies after the swap but before depositing
  leaves the creator holding the stock tokens in their wallet (not lost, not in
  the treasury). **The UI must say this** — `useBasketRunner` renders the step
  list explicitly ("Swap ETH into N assets", then per-asset "Approve"/"Deposit")
  and must never imply one signature covers the whole basket. Documented in
  `docs/DECISIONS.md` §1/§7.

---

## 5. Test counts

| Suite | Result |
|---|---|
| `BasketZap.t.sol` (unit/fuzz, guard rails) | **17 passed**, 0 failed |
| `BasketZapFork.t.sol` (real mainnet fork, real Fables/Ramses swaps) | **11 passed**, 0 failed |
| **Contracts total (basket)** | **28 passed, 0 failed, 0 skipped** |
| `web` `tsc --noEmit` | clean |
| `web` vitest | **88 passed** |
| Playwright `basket.spec.ts` | **5/5 consecutive green** (see §7) |

The fork suite executes the REAL production path end-to-end: ETH →
(Ramses) → stock → `approve` → `deposit` → real `BackingLens` readback, on both a
fresh gen-4 launch and the real existing launch id 2, plus per-leg venue
fallback (SGOV, no Fables route, falls through to Ramses) and the
all-venues-failed revert. No `TestPoolSeeder` shim — the routes are real.

---

## 6. Updated deploy checklist

`docs/BASKET_DEPLOY.md` is updated for the new constructor (gas is now ~6.23M,
~0.00025 ETH — confirmed by a no-broadcast dry-run), the array-arg verify
command (`--guess-constructor-args`, with an explicit-args fallback), and the
new "enable only the 7-asset routable set + wire the index-based `Leg` shape"
gate. **Do not deploy** (per the brief) — the runbook is ready for a human.

---

## 7. Playwright e2e — now stable (5/5 consecutive green)

The harness was rewritten for the new flow (no `TestPoolSeeder`, no
`basketRoutes.ts` override — NVDA is in the production routable set now, swapped
through the real on-fork Ramses pool).

The **root cause of the prior 2/3 instability** was pinned down and fixed: Anvil
forking this ~100ms-block chain raced the upstream RPC's state-pruning, so the
setup's deploy tx intermittently failed with `historical state ... is not
available` (the same wall documented in
`contracts/script/probe/ProveMultiQuoteSwap.s.sol`). Three mitigations in
`web/e2e/global-setup.ts` cleared it:

1. **Pin the fork a few blocks behind head** (`--fork-block-number latest-16`) —
   a settled block still inside the node's recent-state window, which anvil then
   caches every touched slot from, instead of racing `latest`.
2. **`--no-rate-limit`** on anvil — the burst of setup reads isn't throttled.
3. **`--legacy`** on the setup forge script — forge uses `eth_gasPrice` (served
   from anvil's cached fork state) instead of EIP-1559 fee estimation, which was
   the specific call reading the pruned historical state.

Result: **5 consecutive full runs, all green** (each ~1.5–1.8 min, full
anvil-fork → deploy → next-dev → browser cycle per run). Combined with the
deterministic suites (`tsc` clean, vitest 88/88, contracts 28/28), the whole
basket stack is green.

Note: this stabilizes the **basket** e2e specifically (`basket.spec.ts`, the
spec this PR's work touches). The broader `/app/backing` suite has its own
pre-existing, separately-logged flakiness (`docs/DECISIONS.md`) around live
Ramses-position / summary-card reads that is outside this rewrite's scope.
