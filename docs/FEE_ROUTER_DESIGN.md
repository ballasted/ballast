# Fee Router — research + design (v1)

Status: designed and implemented 2026-09-30. Not yet deployed to mainnet (needs
a funded deployer keystore — see docs/safe-tx-fund-feerouter-deployer.json).

## 1. Research findings

### 1.1 Can `launch()` be called by a contract?

**Yes.** `BallastFactory.launch()` (`contracts/src/BallastFactory.sol:340`) has no
`tx.origin`/EOA check. It records `msg.sender` as:

- `BallastToken.creator` (immutable, constructor arg) — the fee-accrual identity
  the Hook reads (`BallastToken(token).creator()` in `BallastHook._distribute`).
- `ProjectTreasury.creator` (immutable, constructor arg) — the only address that
  can deposit-withdrawable, accept/decline third-party deposits, and run the
  withdrawal lifecycle.

Both are set from the **same** `msg.sender` in one atomic `launch()` call. So a
contract that calls `launch()` itself becomes the on-chain "creator" for *both*
fee accrual and treasury control, for that one token.

Consequence: a **per-token router**, deployed before `launch()` and calling
`launch()` itself, gets exclusive, uncommingled `owed[router]` fee accrual and
treasury-creator control — with no changes to Factory/Hook/Treasury/Token.
A single *shared* router used as creator across many tokens would NOT work:
`BallastHook.owed` and `owedIn` are keyed only by address, not by
(address, token) — fees from two tokens with the same recorded creator land in
the same bucket, indistinguishable. Fee Router v1 is therefore **one dedicated
router contract per token**, deployed via `FeeRouterFactory.createAndLaunch(...)`
in the same transaction that calls `launch()`.

### 1.2 How do creator fees accrue and get claimed?

`BallastHook` (`contracts/src/BallastHook.sol`) keeps a pull ledger:

- WETH: `owed[recipient]`, claimed via `claim()` — **pays `msg.sender`**, keyed
  by `msg.sender`, not a passed-in address. There is no "claim on behalf of"
  entrypoint (and we must not add one — Hook is frozen).
- Any other quote asset: `owedIn[recipient][currency]`, claimed via
  `claimIn(currency)`, same `msg.sender`-keyed pull.

Only WETH pools are launchable today (`BallastFactory.isGreenQuoteAsset` is
empty on the live factory), so in practice **100% of live trading fees are
WETH**. `owedIn`/`claimIn` exist as inert infrastructure in the Hook already
("land the general logic now, unlock it later" — Hook's own doc comment).
FeeRouter mirrors that: it has a `routeIn(address currency, ...)` path wired to
`claimIn`, but v1 only ships the WETH path as user-facing; the multi-currency
path is dead code today, alive the moment a non-WETH pool graduates.

Direct implication of "pays `msg.sender`, keyed by `msg.sender`": **only the
recorded creator address itself can ever pull its owed WETH.** For a router to
receive fees automatically it must *be* that address (§1.1). For an existing
token (creator = an EOA already), no contract can ever call `claim()` on that
EOA's behalf — Solidity has no way to make `msg.sender` be someone else's
address. See §1.4.

### 1.3 Can the Creator-withdrawable treasury part be sent somewhere other than the creator wallet?

`ProjectTreasury.executeWithdrawal` (`contracts/src/ProjectTreasury.sol:292`)
hardcodes the destination: `IERC20(w.asset).safeTransfer(creator, w.amount)`.
It is never a parameter and never `msg.sender` (`announceWithdrawal`/
`executeWithdrawal`/`cancelWithdrawal` are `onlyCreator`, but the payout target
is always the immutable `creator` field, not the caller). So: **no external
address can ever be the destination directly.** The only way to redirect it is
the same trick as §1.1 — make `creator` itself be a router contract, which then
receives the withdrawal and forwards it under its own logic. This only works
for tokens launched *through* the router (§1.1), not existing ones.

### 1.4 Existing tokens

For a token already launched with an EOA creator, neither §1.2 nor §1.3 can be
redirected — Solidity's `msg.sender` cannot be spoofed and Treasury's payout
address is fixed. The creator can still **use** a router, but only through a
helper the creator personally calls each time:

1. Creator calls `hook.claim()` from their own wallet (receives WETH to the EOA
   — normal, unavoidable, already how it works today).
2. Creator calls `FeeRouterFactory.adoptExisting(token, treasury, splits, ...)`
   once to deploy a standalone router bound to their token (the router is NOT
   the on-chain creator here — it only holds config and buckets).
3. Creator sends the claimed WETH to that router (`transfer` + `router.route()`,
   or a single `router.routeFrom(amount)` that pulls via `transferFrom` after an
   `approve`) whenever they want to route a batch.

This is the "claim-and-route helper" the task anticipated. It is **not**
permissionless end-to-end for existing tokens (step 1 needs the creator's own
signature — nothing can change that), but steps 2–3 reuse the exact same
`FeeRouter` contract and bucket logic as router-native tokens. `route()` itself
(splitting whatever WETH balance the router already holds across the four
buckets) is permissionless either way, same contract, same tests.

## 2. Chosen design

### 2.1 Two ways a token gets a FeeRouter

| | Router *is* on-chain `creator` | Router is a plain bucket-splitter |
|---|---|---|
| How | `FeeRouterFactory.createAndLaunch(...)` deploys the router, router calls `BallastFactory.launch()` itself | `FeeRouterFactory.adoptExisting(token, treasury, ...)` — no `launch()` call |
| Fee pull | `router.route()` calls `hook.claim()` itself — fully permissionless | Creator must `hook.claim()` themselves, then send WETH to the router |
| Treasury bucket | Router can `proposeDeposit` + `acceptDeposit` in one call (it IS `treasury.creator`) | Not available — router isn't treasury's creator, can't accept |
| Metadata / treasury creator actions | Must go through router passthroughs (`setMetadataURI`, `announceWithdrawal`, etc. — gated to `realCreator`) | Unaffected — creator keeps direct control, uses Treasury/Token normally |

Both cases share the exact same `FeeRouter` contract and the exact same
`route()` bucket-splitting logic. The only difference is *how WETH gets into
the router* and *whether the treasury bucket is available* (it needs
`treasury.creator == router`, which only the first path gives you).

### 2.2 `FeeRouter` — one per token

Immutable at construction (no upgrade path, no platform key):

- `realCreator` — the human who launched the project; the ONLY privileged
  caller, and only for: scheduling a split change (§2.3) and the
  Token/Treasury creator-passthrough calls listed above. `realCreator` can
  never redirect funds outside the four buckets and can never touch the
  locked treasury balance.
- `token`, `treasury`, `hook`, `weth` — resolved once, never changed.
- `treasuryAsset`, `treasuryPoolKey` — the asset bucket (b) swaps WETH into and
  deposits as locked-forever, and the WETH/`treasuryAsset` pool to swap through.
  Immutable: no scheduled-change surface for a pool key (liquidity-source
  changes are a bigger decision than a split retune, and this keeps the attack
  surface small). Left unset (`treasuryAsset == address(0)`) disables bucket
  (b) permanently for that router — set `treasuryBps = 0` in that case
  (checked in the constructor).
- `disclosureVersion` — fixed hash of the standard "auto-routed trading fee,
  permanently locked, no claim" disclosure text, used on every
  `proposeDeposit` the router makes.

Mutable, scheduled (§2.3): `creatorBps`, `treasuryBps`, `buybackBps`,
`rewardsBps` (sum to 10 000; default `creatorBps = 10000`, rest 0).

Buckets, run inside `route()`:

- **(a) Creator** — plain `transfer(realCreator, amount)`.
- **(b) Treasury** — `poolManager.swap` WETH → `treasuryAsset` against the
  immutable `treasuryPoolKey` (same direct-PoolManager pattern as
  `BuybackBurnerV2`, not the UniversalRouter — see §2.4), then
  `treasury.proposeDeposit` + `treasury.acceptDeposit` in the same call (only
  possible when `treasury.creator == address(this)`).
- **(c) Buyback & burn** — WETH → `token` against `buybackPoolKey` (wired once,
  permissionlessly, after graduation — see §2.5), send the bought tokens to
  `0x…dEaD`.
- **(d) Holder rewards** — transfer WETH to this token's `HolderStakingVault`
  and call `notifyReward(amount)`.

Safety, mirrored from `BuybackBurnerV2`/`FeeSplitter`:

- `maxRoutePerCall` (immutable) — per-call cap on total WETH routed.
- `routeCooldown` (immutable) — minimum gap between `route()` calls.
- Caller-supplied `minAmountOut` per swap bucket, independently bounded by an
  immutable `maxSlippageBps` checked against the pool's own spot price at
  execution (never trusts the caller's number alone).
- `nonReentrant` on every state-changing external function.
- Every bucket emits its own event; `route()` overall emits a summary event.

### 2.3 Scheduled split changes

`scheduleSplit(creatorBps, treasuryBps, buybackBps, rewardsBps)` — `realCreator`
only. Emits `SplitScheduled(..., effectiveAt = block.timestamp + 7 days)`.
`route()` (and a explicit `applySplit()`) checks `block.timestamp >=
effectiveAt` and swaps `pending` into `active` exactly once. Only one pending
change at a time (matches `ProjectTreasury`'s "one active withdrawal at a time"
shape). No owner can shorten or skip the delay — it's a fixed immutable
constant, not configurable.

### 2.4 Treasury-bucket swap: direct `PoolManager`, not UniversalRouter

CLAUDE.md flags the UniversalRouter on this chain as a **modified fork** with
an extra `minHopPriceX36` field — stock Uniswap SDK calldata reverts, and
getting a bespoke on-chain encoder right without a live fork test is exactly
the kind of unverified, funds-at-risk code CLAUDE.md says to stop and flag.
`BuybackBurnerV2` already proves a safer path exists on this chain: skip the
router entirely and call `PoolManager.unlock`/`swap` directly against a known
`PoolKey`, exactly like it does for the buyback leg. `FeeRouter` reuses that
same pattern for the treasury-asset leg. The tradeoff: the WETH/`treasuryAsset`
pool's `PoolKey` (fee tier, tick spacing, hook address) must be supplied at
router-construction time by whoever sets it up, the same way `BuybackBurnerV2`'s
constructor took explicit, pre-verified `PoolKey`s rather than discovering them
on-chain. The setup script must verify the pool (`StateView.getSlot0`) before
passing it in — documented in `contracts/script/DeployFeeRouter.s.sol`.

### 2.5 Buyback pool: derived, not supplied

Unlike the treasury pool, the token's own WETH pool is fully determined by
already-public values **after graduation**: `currency0/1 = sort(token, weth)`,
`tickSpacing = BallastFactory.TICK_SPACING()` (60, constant), `fee = 0` (Ballast
pools take their fee via the Hook, not the v4 LP fee field — confirmed from
`BallastSeeder`'s pool init), `hooks = BallastHook` (singleton, factory-known).
`wireBuybackPool()` is permissionless and callable by anyone once
`BallastFactory.graduated(token)` is true; it computes the `PoolKey` from these
public values (no trust in the caller) and stores it. Until called, bucket (c)
is inert (`buybackBps` can be set, but `route()` skips the swap and leaves that
share as un-routed WETH until the pool is wired — never reverts the whole
`route()` call over one bucket).

### 2.6 `HolderStakingVault` — one per token

Synthetix-style reward-per-token accumulator (`stake`/`unstake` anytime, no
lockup, no APR display anywhere — copy rule). `notifyReward(uint256 amount)` is
callable only by this token's `FeeRouter`. Handles the classic "reward
notified while `totalStaked == 0`" case by **not** folding that amount into
`rewardPerTokenStored` (would divide by zero and strand it) — it accumulates in
`pendingReward` and is included whole in the next `notifyReward` call once
someone has staked. Late stakers only start earning from their stake
timestamp forward (`userRewardPerTokenPaid` checkpoint at `stake()`) — the
standard accumulator property, unit-tested explicitly.

### 2.7 Currencies

v1 ships the WETH path only (100% of live fee volume, §1.2). `routeIn(address
currency)` exists and is fully implemented against `owedIn`/`claimIn`, but is
untested against a live non-WETH pool (none exists yet) and is not exposed in
the UI until one does — same "land the logic, unlock it later" posture as the
Hook itself.

## 3. What's explicitly NOT in v1

- Changing `treasuryAsset`/`treasuryPoolKey`/`buybackPoolKey` after they're set
  (immutable/one-time-wire only — reduces the surface a compromised
  `realCreator` key could abuse).
- Routing the treasury's **existing** creator-withdrawable balance (assets the
  creator deposited themselves, not fee-derived) through the four buckets.
  That would require the router to run Treasury's `announceWithdrawal` /
  `executeWithdrawal` lifecycle (7/30/90-day notice) on assets that were never
  fees — a materially different, slower, creator-initiated flow. Left as a
  clearly-labeled future extension (`routeTreasuryWithdrawable`), not built in
  v1, so it doesn't get conflated with the permissionless fee path in review or
  in the UI copy.
- A generic "claim on behalf of" primitive — impossible without changing the
  frozen Hook/Treasury, and out of scope per the hard rules.
