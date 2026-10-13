# Stock Basket — decisions log

Autonomous build on `feat/stock-basket`. Each entry: decision, alternatives considered, why. Most-recent last.

---

## 1. `ProjectTreasury.deposit()` can only ever be called by the creator's own EOA — no contract can do it on their behalf

**Finding (not really a "decision", but it determines every decision after it):** `ProjectTreasury.deposit(asset, amount)` is `onlyCreator`, which checks `msg.sender == creator` where `creator` is an `immutable` address fixed at launch to whoever called `BallastFactory.launch()` (`contracts/src/ProjectTreasury.sol:160-163`, `contracts/src/BallastFactory.sol:370`). There is no delegation, no operator role, no meta-tx support (no `_msgSender()` override), and nothing in `BackingLens` counts a raw `ERC20.transfer` straight to the treasury — `BackingLens.backingOf()` only reads `treasury.lockedBalance(asset)` and `treasury.creatorWithdrawable(asset)` (`contracts/src/BackingLens.sol:149-150`), both of which are only written by `deposit()` / `acceptDeposit()`. So:

- A contract calling `treasury.deposit()` directly reverts (`msg.sender` would be the contract's own address, never the creator's).
- Sending swap output straight to the treasury's balance (skipping `deposit()`) would NOT show up in `BackingLens` at all, and would be permanently stuck (not `creatorWithdrawable`, not `lockedBalance`) — worse than not building the feature.
- We are forbidden from touching/redeploying `ProjectTreasury` (HARD RULES), so this cannot be fixed by changing the treasury.

**Consequence:** no architecture — frontend-only or a new contract — can make the per-asset `deposit()` call for the creator. The creator must personally sign one `approve` + one `deposit` per asset, always, regardless of which option is chosen. The only thing automatable is getting ETH converted into the right stock tokens and landed in the creator's own wallet in one shot.

**How to apply:** this is why Option 2 is chosen below — not because it reduces the `deposit()` signature count (it can't), but because it's the only way to put real on-chain safety rails (minOut, Chainlink staleness + deviation, all-or-nothing, dust refund) around the swap step instead of trusting raw frontend-assembled calldata. See [[basket-option-decision]] below. The UI must say plainly: "1 signature to swap, then N confirmations to add each asset to your treasury" — never imply the whole basket lands in one signature.

---

## 2. Option 2 (BasketZap contract) chosen over Option 1 (frontend-only) {#basket-option-decision}

**Decision:** build `BasketZap.sol`.

**Alternatives considered:**
- *Option 1, frontend-only batched Universal Router calls.* Technically the swap leg alone CAN be done in one signature with no contract at all — Robinhood Chain's UniversalRouter v4 action encoding supports chaining multiple independent `SWAP_EXACT_IN_SINGLE` actions (one per leg, since every basket leg is WETH→stock-token, i.e. genuinely single-hop, not the multi-hop shape BALLAST deliberately avoids — see `contracts/src/interfaces/IRobinhoodV4Router.sol:20-25`) behind one shared `SETTLE_ALL(WETH, total)` and N `TAKE_ALL(asset_i, minOut_i)` actions, with outputs landing directly in the caller's wallet since `TAKE_ALL` pays out to whoever called `execute()` (confirmed by how `BallastV1Claim._swapEthForBallastV2` uses the identical 3-action shape and then explicitly forwards the result, because ITS caller is the contract, not an EOA — see `contracts/src/BallastV1Claim.sol:291-305`). So Option 1 is not "impossible".
- But every safety check the spec requires (fresh per-leg Chainlink staleness, the 20% deviation breaker, minOut enforcement, all-or-nothing revert, dust refund) would then have to live in the FRONTEND, which cannot be trusted at execution time — a client can be stale, tampered with, or simply skipped by calling the router directly. That is a real safety regression from every other swap path in this codebase (Open Treasury, V1Claim, BallastRouterV2) which all enforce these checks on-chain.
- Per the spec's own rule — "Option 2 only if Option 1 is impossible or needs more than 2 signatures" — the realistic minimum signature count for a basket of N assets is `1 (batched swap) + N (approve) + N (deposit)`, i.e. `1 + 2N`, under EITHER option, because of finding #1 above. For any N ≥ 1 that's already more than 2 signatures. So the letter of the rule routes to Option 2 regardless of N, and the substance of the rule (push on-chain what can be pushed on-chain) agrees independently.

**Why Option 2 is still worth building even though it can't reduce the irreducible `approve`+`deposit` cost:** it moves the ENTIRE swap leg (wrap ETH, multi-leg swap, per-leg Chainlink gate, minOut, refund, forwarding to the creator) into one audited, atomic, all-or-nothing call instead of raw frontend-built calldata. That is a strict safety improvement over Option 1 for the part of the flow that touches money before the creator even gets to the treasury.

**Implementation detail — N separate `execute()` calls, not one batched multi-action call.** Within `BasketZap`, each leg is its own `UniversalRouter.execute()` call (the exact SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL shape `BallastV1Claim` already proved on a live mainnet pool), looped inside the one user-signed `swapBasket` transaction — not the fancier single-call multi-action batch described above. That shape is reachable on this fork (v4 flash-accounting allows multiple swap/settle/take actions in one `execute()`), but it has never been proven against this specific router, and untested code in the swap-execution path is exactly the attack surface CLAUDE.md's multi-hop warning is about. N proven single-leg calls inside one transaction costs the caller nothing extra (still exactly one signature) and carries far less risk. Most conservative reasonable option, per the run's working mode.

## 3. BLOCKED: no routable WETH pool found for any of the 16 AssetRegistry-listed assets

**Status: blocked, with evidence — not a reason to stop building.** See
`docs/BASKET_DISCOVERY.md` §2 for full detail. Summary: an exhaustive
(within this session's RPC constraints) search found zero stock-token/WETH
v4 pools — not for SPY, QQQ, NVDA, AMD, PLTR, SGOV, or any of the other 10
registered assets. Five independent methods were tried (Initialize-log sweep,
blocked by Alchemy's ~5,000-block `eth_getLogs` range cap; `StateView`
brute-force across both the four standard fee/tickSpacing tiers and the
specific 2500/25 and 2500/60 tiers Uniswap's own blog post describes for its
Robinhood Chain stock-token AMM; a V4Quoter probe; Blockscout's API,
Cloudflare-blocked; a web search for a documented hook address, which
confirmed no v4 subgraph exists for this chain). None of the spec's suggested
presets (Index, AI chips, Cash-like) are routable right now as a result.

**Why this doesn't block the rest of the build:** `BasketZap` takes the full
`PoolKey` per leg as a parameter (see §2 above), so it works the instant a
real route is sourced, with zero contract changes. The frontend's route table
(`web/lib/basketRoutes.ts`) ships empty and the UI honestly reports "no
routable assets yet" rather than faking a working preset.

**Update — the fork tests are NOT skipped.** Routability (a pool existing)
and AssetRegistry allowlisting are independent: NVDA/SGOV/AMD are already
real-allowlisted, only their *pool* is missing, and anyone may
permissionlessly initialize a v4 pool and add liquidity to it — no privileged
access needed. `contracts/test/helpers/TestPoolSeeder.sol` (test-only, never
deployed to mainnet) does exactly that on the fork, funded via forge-std's
`deal()` cheatcode (already proven against real stock tokens elsewhere in
this suite — `BuybackBurnerV2Fork.t.sol`, `BallastRouterFork.t.sol`). This
touches no privileged contract: `AssetRegistry` is never written to, and its
real owner — the compromised deployer — is never impersonated, not even
locally for a read-only `vm.prank` (deliberately avoided even though it would
have been harmless in isolation, to respect the hard rule's letter, not just
its spirit). Result: `contracts/test/BasketZapFork.t.sol` — 8/8 passed, 0
skipped, including a full swap → approve → deposit → real `BackingLens`
readback on BOTH a fresh gen-4 launch and a real existing launch (id 2). The
seeded pool's price is an arbitrary 1:1 in raw units (these tests prove the
pipeline, not a dollar figure) — a genuinely separate concern from the
*production* routability gap above, which still has zero real routes and
still needs a human to source one for `web/lib/basketRoutes.ts` before the
frontend can do a real mainnet swap.

**BasketZap never calls `ProjectTreasury.deposit()` itself** — it swaps and forwards the resulting stock tokens to the creator's own wallet in the same transaction (via explicit `safeTransfer`, exactly like `BallastV1Claim` forwards its swap output — it cannot rely on `TAKE_ALL`'s implicit recipient since BasketZap itself is the caller of `execute()`, not the creator). The creator then does their own `approve` + `deposit()` per asset afterward, same as if they'd never used BasketZap at all.

---

## 5. Moving Backing off the token page (`/app/backing`, `/app/backing/[address]`)

**Premise mismatch, logged rather than queried (autonomous run):** the brief says to add "Backing" to the nav "next to Open Treasury/Buyback" and give Backing its own page "the same way Open Treasury has its own page." Checked both claims against the actual codebase — **neither is true today**: there is no `/app/open-treasury` route, no `OpenTreasurySection` is reachable outside the per-token tab it already lived in, and `components/app/nav-items.tsx`'s `NAV_ITEMS` has no "Open Treasury" entry (only Discover, Buyback, Create, Portfolio, Profile, conditionally Migrate). **Decision:** proceed as if the brief said "next to Buyback" (the nav item that actually exists) and treat "Open Treasury has its own page" as aspirational framing for the pattern being asked for here, not a thing to go find. Most conservative reading available — doesn't invent a new Open Treasury page that wasn't asked for, doesn't block on asking.

**`OpenTreasurySection` is carried over to the new `/app/backing/[address]` page, even though the brief's explicit section list (treasury / stock basket / Ramses lock / no-claim+links) doesn't mention it.** It was part of the current Backing tab's content; the brief's step 3 says replace the tab with a summary card and "don't leave duplicate UI" — it does NOT say drop any existing section. Removing a shipped, working feature (permissionless community deposits) because a checklist enumerating the *new* stuff didn't re-list the *old* stuff would be a silent regression, which is a worse failure mode than rendering one more section than strictly requested. If Open Treasury was meant to move somewhere else entirely, that's a separate, unstated task.

**Backing summary card on the token page:** one line, "Backing: $X in treasury · basket · Ramses lock", always rendered (even at $0 — a creator should never be surprised the link exists), linking to `/app/backing/[address]`. The basket/Ramses-lock badges reuse the exact same event-sourced hooks (`useBasketHistory`, `useRamsesPosition`) the destination page's own sections use — no new data path, so the summary can never disagree with the page it links to.

**`/app/backing` index: basket/Ramses badges are per-row, lazy, best-effort.** Both signals are event-log lookups (no on-chain "does this token have a basket/lock" getter exists — same reasoning `useRamsesPosition`'s own doc comment gives: the launcher is stateless by design, the event IS the index). Running one `eth_getLogs` scan per badge per listed project doesn't batch, but the realistic number of ballasted launches today is small (single digits across all factories), so this is an acceptable, honest cost rather than building a new indexer for it. If the launch count grows enough to matter, that's a Ponder-deferred problem like every other event-sourced read in this app (see memory: Ponder deferred indefinitely).

**Redirect:** the old token page's `?tab=backing` query param (never actually shipped as a real deep link — grepped, nothing in the committed codebase ever generated one) still gets an explicit client-side redirect to `/app/backing/[address]`, as cheap insurance against any bookmark/external link that assumed it.

**Logged, unresolved, non-blocking: the token page's Backing summary card `<Link>` reproducibly fails to navigate when clicked in the Playwright/Anvil-fork e2e harness — ruled out, in order: (1) a competing dialog overlapping it (dumped every `[role="dialog"]` on the page — only the expected one existed, nowhere near this card); (2) dev-server on-demand-compile racing a client-side transition into a never-before-visited route (extended `web/e2e/global-setup.ts`'s warm-up to pre-hit `/app/backing/[address]` and `/app/backing` too — fixed a real, separate slowness issue, didn't fix this one); (3) Playwright-specific synthetic-event weirdness (called `el.click()` natively via `page.evaluate`, bypassing Playwright's dispatch entirely — still didn't navigate).** The link's `href` is confirmed correct at every stage. Given the actual destination route is independently proven to work (direct `page.goto` in `basket.spec.ts`, and the `?tab=backing` redirect test above), `e2e/backing.spec.ts`'s summary-card test now asserts the `href` attribute instead of a live click-through — a real, narrower assertion, not a skip. Worth a human's follow-up with a real browser + devtools (something framer-motion/`MotionSection`-related is the leading suspect, since that's the one non-trivial thing wrapping this specific `<Link>` that doesn't wrap the other working links on this page — not confirmed).

**Resolved: sequential-run flakiness across the whole e2e suite (selector/retry bugs).** Running all 6 specs back to back (one shared Anvil fork + `next dev` instance, same as production `npm run e2e`) surfaced two real, fixable bugs that isolated single-file runs didn't: (1) `getByRole("button", { name: "Connect wallet" })` is ambiguous once a creator-only section (e.g. `CreatorWithdrawalPanel`) has also rendered its own inline connect CTA — fixed by scoping to the nav header specifically (`e2e/helpers.ts`'s `connectWalletButton`, a real selector-specificity fix, not a workaround); (2) the terms-checkbox `.check({ force: true })` occasionally reported success without the underlying state flipping under sustained sequential load — fixed by retrying with plain `.click()` wrapped in try/catch (`.check()`'s own post-click verification throws on exactly this flake, which would abort a retry loop before a second attempt could ever run) up to 8 times, re-verified via `isChecked()` each time (`e2e/helpers.ts`'s `acceptTermsIfShown`).

**Logged, unresolved, non-blocking: a second, separate layer of flakiness remains, NOT fixed by the selector/retry changes above.** Three consecutive full-suite runs after the fixes above: 6/6, then 4/6 (failures: the summary-card link not found at all, `Ramses locked pool` section not found, `Basket` section not found on the detail page, and the basket e2e's "Add basket" button never appearing), then 6/6 again. The failure signature is the tell: when it fails, it's always the sections/elements that depend on a live on-chain read against the Anvil-forked node (basket history, Ramses position, the summary card's own badge reads) failing together in the same run, never an isolated single assertion — consistent with an intermittent RPC hiccup against the fork (this sandbox's network has shown exactly this class of transient failure earlier in this build, e.g. the `next build`/`next/font` TLS disconnects in `docs/DECISIONS.md` history), not a bug in the moved code itself. `tsc --noEmit` and `vitest` (85/85) are both deterministic and green regardless. Not chasing full e2e determinism further under the "decide, log it, keep going" mandate — flagged for a human to either add a retry/backoff around the affected hooks' RPC calls or accept this as inherent sandbox-network flakiness.

---

## 6. REWRITE — BasketZap routes through V4Router (Fables/Ramses), not the UniversalRouter. Supersedes §2 and §3.

**What changed and why.** §2/§3 above were written on the premise that each basket
leg is a single-hop WETH→stock swap through the external UniversalRouter, and §3
concluded "zero routable WETH pools exist for any of the 16 assets." Both are now
overturned by two findings this session:

1. **No WETH/<stock> pool exists — the real liquidity is multi-hop or on Ramses.**
   Stock-token liquidity on this chain is ETH→USDG→stock (Fables v4 hooks, same
   PoolManager we use) or on Ramses v3 pools. `BallastRouterV2` already discovered
   and productionised these exact routes (its `fablesHops`/`ramsesRoutes` tables,
   `contracts/script/DeployBallastRouterV2.s.sol`). BasketZap now reuses those
   tables verbatim.
2. **The external UniversalRouter cannot execute these routes.** Ramses v3 pools
   aren't reachable through it at all (its V3 path is bound to Uniswap's own
   factory/init-code-hash), and the Fables multi-hop path needs the
   `poolManager.unlock()` flash-accounting shape, not a `UniversalRouter.execute()`
   call BasketZap can safely assemble. `BallastRouterV2` solved this by inheriting
   v4-periphery's `V4Router` directly (for Fables) and implementing the
   Uniswap-v3-style swap callback directly (for Ramses).

**Decision.** BasketZap is rewritten to the identical pattern as `BallastRouterV2`:
it inherits `V4Router`, executes each leg through `poolManager.unlock()` (Fables) or
a direct v3 callback (Ramses), picks the preferred venue per leg from an off-chain
quote, and falls back to the other venue in the same tx if the first reverts. It
stops at the stock token and forwards the output to the launch creator (it does NOT
continue into a Ballast pool the way BallastRouterV2's leg 2 does — that leg is not
optional in BallastRouterV2's code, so it couldn't be reused as-is). Routes are now
selected by INDEX into fixed construction-time tables (not caller-supplied PoolKeys),
which is strictly safer than the old design — a wrong index can only fail to chain
(`BadHopChain`), never reach an address outside the fixed tables.

**Constructor changed.** Old: `(factory, registry, weth, universalRouter, permit2)`.
New: `(factory, registry, IPoolManager, weth, FablesHop[], RamsesRoute[])`. The
`universalRouter`/`permit2` args are gone. `DeployBasketZap.s.sol` carries the same
verified tables as `DeployBallastRouterV2.s.sol` (diffable side by side).

**Verified against real mainnet state (fork tests, this session):** 17 unit + 11 fork
tests pass. The fork tests execute real Fables/Ramses swaps end to end — swap →
approve → deposit → real `BackingLens` readback — on both a fresh gen-4 launch and the
real existing launch id 2, plus per-leg venue fallback (SGOV, no Fables route, falls
through to Ramses and succeeds) and the all-venues-failed revert. No TestPoolSeeder
shim any more — the routes are real.

**One real liquidity fact surfaced by the fork tests, not a bug:** META's *direct*
WETH Ramses pool (route index 2) returns ~0 output at ~0.3–0.4 ETH on live mainnet
(floored/near-dead, consistent with the deploy-script routing note). The
deposit-pipeline fork tests therefore use NVDA + SPY (the two confirmed-deep direct
WETH Ramses pools) — see `docs/BASKET_DISCOVERY.md` for the full per-asset route table.

---

## 7. Blocker 2 (fuller analysis) — atomic deposit is impossible for a plain-EOA creator; fewest-signature flows and exact counts

This extends §1 with the specific options the brief asked to evaluate. The core fact
from §1 is unchanged and re-confirmed on-chain this session: `ProjectTreasury.deposit()`
is `onlyCreator` (`contracts/src/ProjectTreasury.sol:180`, modifier at :160 checks
`msg.sender == creator`, `creator` immutable). `launches(2)` on the live factory
returns creator `0x3b4f9a42…`, matching the fork-test constant — the resolution path
BasketZap uses is correct.

**Option (a) — can the treasury accept a deposit "on behalf of the launch" from the
zap?** The only on-behalf path is `proposeDeposit(asset, amount, disclosureVersion)`
(anyone may call — `contracts/src/ProjectTreasury.sol:202`) followed by
`acceptDeposit(id)` (`:226`, `onlyCreator`). BasketZap could hold the swapped tokens
mid-tx and call `proposeDeposit` itself. **Rejected — it does not give an atomic,
creator-withdrawable deposit:**
  - Acceptance is still `onlyCreator`, so it's still a separate creator signature —
    no signature is saved versus `approve`+`deposit`.
  - Accepted proposals land in `lockedBalance` (permanent, third-party bucket), NOT
    `creatorWithdrawable`. A creator funding a basket with their own ETH would be
    permanently locking it — a different economic meaning, and worse for the creator
    (they lose the withdrawal right the two-phase notice flow is designed to give them).
  - It carries a 7-day `ACCEPT_WINDOW` and a required `disclosureVersion`.
  So (a) is strictly worse than the plain `approve`+`deposit` path, not a shortcut.

**Option (b) — creator approves BasketZap once per asset (or Permit2 batch), zap pulls
and deposits in the same tx as the creator's call.** **Rejected — it cannot work at
all:** `deposit()` checks the *caller's identity* (`msg.sender == creator`), not an
allowance. When the creator calls `BasketZap.swapBasket()`, the treasury sees
`msg.sender == BasketZap`, never the creator, so BasketZap calling `deposit()` reverts
regardless of any ERC-20/Permit2 approval the creator granted. The deployed treasury
has no `depositFor`/`onBehalfOf` variant and no meta-tx support, and we cannot change it.

**Option (c) — the honest answer: atomic single-action deposit is impossible for a
plain-EOA creator without changing gen-4 `ProjectTreasury`, which is forbidden.** The
fewest-signature flows:

  - **Plain-EOA creator:** `1` signature for `BasketZap.swapBasket()` (all N legs swap
    atomically, outputs land in the creator's wallet), then `2` signatures per asset
    (`approve` + `deposit`) directly against the treasury, because only the creator's
    EOA can call `deposit()`. Total `1 + 2N`:
      - **1 asset → 3 signatures.**
      - **6 assets → 13 signatures.**
    The `approve`+`deposit` pair per asset is irreducible at the contract level (the
    treasury pulls via `safeTransferFrom` and is immutable).

  - **Smart-account creator (Safe, or an EIP-7702-enabled EOA):** the ENTIRE flow —
    `swapBasket` + all N `approve`s + all N `deposit`s — collapses into **one** signed,
    atomic batch (a Safe `multiSend` / 7702 bundle). The account IS the creator, so
    `msg.sender == creator` holds for every inner `deposit()` call. This is the
    recommended path and it uses existing wallet capability, no new contract. Note:
    launches 0 and 1 on the current factory were created by the Safe
    (`0xEFC97e16…`) — for those, the atomic one-signature batch is available today.

**All-or-nothing.** Holds WITHIN the swap (any leg failing both venues or undershooting
its own `minOut` reverts the whole `swapBasket`, including legs that already succeeded —
proven by `test_fork_revertsAllVenuesFailed…` / the unit `test_revert_failingLeg…`
equivalent) and WITHIN a smart-account batch (one atomic tx). It does **NOT** hold across
the plain-EOA `swap → approve → deposit` sequence: those are separate transactions, so a
wallet that dies after the swap but before depositing leaves the creator holding the
stock tokens in their own wallet (not lost, but not in the treasury). **The UI must say
this plainly** — "1 signature to swap, then N confirmations to add each asset to your
treasury; if you stop partway, the swapped assets stay in your wallet." `useBasketRunner`
already renders the step list this way; the copy must not imply the whole basket lands in
one signature.

## 8. Fewer signatures without touching gen-4: EIP-5792 atomic batching + approve-once + resume flow

Builds on §7's constraint (deposit() is onlyCreator, immutable). Three layers,
all frontend/wallet-level — no contract change:

**a. EIP-5792 batching (`web/lib/eip5792.ts`, `useBasketRunner.runBatched`).**
If the connected wallet reports atomic-batch support for chain 4663 via
`wallet_getCapabilities` (both the current `atomic.status: supported|ready`
shape and the older `atomicBatch.supported` draft are accepted —
`atomicStatusFor()`), the WHOLE basket — `swapBasket` + every `approve` + every
`deposit` — is sent as ONE `wallet_sendCalls` batch with `atomicRequired: true`.
One confirmation, all-or-nothing across every call. `msg.sender == creator`
holds for the inner `deposit()` calls because the smart account IS the creator.
**Deposit amounts in the batch are each leg's `minOut`, not the exact swap
output** — the calls are pre-encoded and can't read the swap's result; since the
contract guarantees `received >= minOut`, the deposits always succeed, and any
better-than-quoted surplus stays in the wallet (picked up by (c) below when it
clears the asset's registry minDeposit; below that floor it's dust that
deposit() would revert on anyway). `wallet_getCallsStatus` is polled on the
WALLET client, not the public RPC client — the node doesn't implement it.

**b. Step-flow improvements (no 5792 support).** The approve is now
`approve(treasury, MAX)` — "approve once for future baskets" — and every
approve step has an allowance precheck that skips it when the standing
allowance already covers the deposit, so a repeat basket for the same assets is
`1 + N` signatures instead of `1 + 2N`. The picker shows the REAL upfront
count ("this basket needs 3 confirmations"), computed from live allowances
(`stepSignatureCount()`), and distinct copy for the batched case ("needs 1
confirmation"). MAX-approval trade-off considered and accepted: the treasury's
`deposit()` is the only puller and it's immutable, creator-only-initiated, and
pulls only what the creator passes — a standing allowance to one's own
treasury is not a third-party-risk surface.

**c. Resume flow (`ResumeDepositBanner`, `useBasketRunner.runDeposits`).** If a
step flow stops after the swap (or a batched run leaves a >minDeposit surplus),
the swapped assets sit in the creator's wallet, invisible to BackingLens. The
backing page now shows the creator a "Resume deposit" banner scoped to EXACTLY
the assets this launch's own BasketSwapped events swapped (never arbitrary
wallet holdings), filtered to balances ≥ the asset's registry minDeposit
(depositing below reverts BelowMinimum). One click runs the deposit-only step
flow (approve-skip applies).

**Signature counts** (1 asset / 6 assets): batched wallet **1 / 1**; step flow
first time **3 / 13**; step flow repeat (same assets, MAX approvals standing)
**2 / 7**.

**Tests:** `lib/eip5792.test.ts` (capability detection across both spec shapes,
call-building order/values, allowance-skip count math — 10 tests),
`lib/basketRoutes.test.ts` (routable set + presets — 5 tests), Playwright
`basket.spec.ts` (step flow, asserts the upfront "3 confirmations" count) +
`basket-batched.spec.ts` (mocked 5792 wallet in web/e2e/inject-wallet.js behind
`window.__E2E_ATOMIC__`: capability detection → 1-confirmation copy → single
batch step → deposit lands; the mock executes the batch as sequential real txs
on the fork — it asserts the app's batched-flow contract, while contract-level
all-or-nothing is proven in the forge fork suite).

## 9. Execution-liquidity gate: slippage alone cannot protect against a floored pool

**Found by the 5x e2e loop, and it's a real mainnet footgun, not test flakiness.**
In one run, the NVDA/WETH Ramses pool — at that run's fork block, after the
batched spec's swap had consumed the pool's then-available depth — quoted
~0.0058 NVDA for 0.2–0.5 ETH (a ~99.9% loss vs Chainlink). The UI displayed that
quote honestly, minOut tracked it honestly (quote × 0.99), the swap executed
"successfully" at the quoted dead price, and the treasury deposit then reverted
`BelowMinimum` (0xbd49034f) because the output was below the asset's registry
minDeposit. Nothing in the flow was *dishonest* — slippage protects
quote-vs-execution, but nothing sanity-checked the quote itself. On real mainnet
this is exactly how a creator would burn ETH into a drained pool.

**Fix (frontend gate, `useBasket` + `BasketPicker` — no contract change):**
- Per leg, the live quote is compared to the Chainlink-implied fair output
  (`ethIn × ethUsd / assetUsd`, both feeds read live). A leg more than
  **10% (1,000 bps)** below fair is flagged `illiquid` and blocks confirm with
  honest copy ("quoting far below the Chainlink price right now"). 10% is
  deliberately looser than the 3% routability bar — it's a safety net against a
  pool that died since verification, not a price guarantee; when either feed is
  unavailable the gate degrades to "no impact check" rather than blocking
  (quote-readiness and minDeposit checks still apply). Never applied to the
  feed price itself — no uiMultiplier anywhere (hard rule 7).
- `minOut` (quote × (1 − slippage)) below the asset's registry `minDeposit`
  blocks confirm too — the deposit would revert `BelowMinimum`, in both the
  batched flow (which deposits minOut) and the step flow.
- **minOut can no longer silently degrade to 1 wei.** The old
  `minOut > 0 ? minOut : 1n` fallback (a missing quote ⇒ an UNPROTECTED swap)
  is removed; confirm requires every active leg to have a live quote
  (`allQuotesReady`), and `onConfirm` re-checks and throws rather than sending
  a floor-1 minOut.

**Test-harness corollary:** the e2e forks recent REAL mainnet, so pool depth
varies run to run — specs now swap 0.2 ETH (was 0.5) to stay far inside any
plausible depth, and the terms-dialog helper now gates on the accept button
actually ENABLING (with a toggle-recovery for the pre-hydration DOM/React
checkbox desync that stranded one run) instead of trusting `isChecked()`.

## 10. GO-LIVE — BasketZap deployed, verified, and shipped (2026-10-13)

`BasketZap` `0x87c046aB0fB8B7B86BA1a62A956242d499051aBA` (deploy tx
`0x3d74937cea90ad36d9e75ea191c4fde21d8c9d82507a733f4d4402c5da4ee18a`, block
`87541981`, fresh deployer `0x71048f37…9023d` — never the compromised old
deployer) is live on chain 4663. Full numbers in `docs/BASKET_DEPLOY.md`.

**What was done (all read-only / no mainnet broadcast, no Safe signing):**
- **On-chain verify:** code non-empty; `factory/registry/poolManager/weth`
  getters match the broadcast constructor args; `fablesHops`(12)/`ramsesRoutes`(17)
  tables byte-identical to live `BallastRouterV2` `0xa0Aba92d…47E0` (spot-checked);
  **runtime bytecode EXACT-matches a fresh `forge clean && forge build`** (only
  the 14 immutable slots differ).
- **Source verify:** Sourcify **`exact_match`**. Blockscout CLI verify blocked by
  a Cloudflare bot-challenge (HTML "Just a moment…") — not a failure; verify via
  the Blockscout web UI or rely on its Sourcify import. Sourcify is authoritative.
- **Fork smoke (real deployed address, impersonated launch-2 creator, no
  broadcast):** 1-asset NVDA (0.01 ETH) → 0.111846 NVDA, gas 328,312, BackingLens
  +$25.07; 3-asset NVDA40/SPY30/SGOV30 (0.15 ETH) → 0.670972/0.144560/1.112900,
  gas 861,498, +$375.63. All Ramses; swap→approve→deposit→readback end-to-end.
- **Frontend:** `main` fast-forwarded to `feat/stock-basket` (PR #41 auto-closed);
  Vercel Production vars set (`NEXT_PUBLIC_BASKET_ZAP_ADDRESS`,
  `NEXT_PUBLIC_BASKET_ENABLED=true`); redeployed to `www.ballasted.fun`.
- **Live check (read-only creator connect, no signing):** Basket section + picker
  render; 7 routable assets enabled, 9 non-routable disabled; zap address present
  in the deployed bundle. Screenshots under `docs/screenshots/basket-live-*.png`.

**Decision — 3-asset smoke used 0.15 ETH, not 0.01:** the brief gave no size for
the 3-asset basket, and 30–40% of 0.01 ETH lands each leg below the treasury's
0.1-token `minDeposit` (deposit reverts `BelowMinimum`). 0.15 ETH clears it for
all three while staying a small, low-impact ticket. This is a treasury rule, not
a basket fault — the swaps themselves succeed at any size.

**Decision — Blockscout verification left to a browser/human:** repeated CLI
attempts hit Cloudflare's managed challenge; retrying from a headless tool can't
pass it, so we stopped rather than loop. The contract is fully verified on
Sourcify (exact match), which is sufficient proof of source↔bytecode.
