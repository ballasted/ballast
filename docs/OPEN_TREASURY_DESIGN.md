# Open Treasury — research + design

Status: designed 2026-10-05, not yet built when this section was written (build
follows in the same work item — see `docs/BALLAST_STATE.md` once merged).

---

## 0. What this is, in one paragraph

A second, separate kind of treasury per token. The existing `ProjectTreasury`
(one per token, deployed at `launch()`) holds **creator-funded, notice-period
withdrawable** ballast and **permanently-locked third-party** ballast — nobody
but the creator ever gets money back out of it, and third-party money is locked
forever by design. Open Treasury is the opposite shape: **anyone** deposits,
**they** get their own principal back whenever they want (after a short
holding period), and in exchange for leaving it in, they earn a pro-rata,
variable share of the token's real trading-fee revenue. It is a new, additive
system — it does not touch `ProjectTreasury`, `BackingLens`, `AssetRegistry`,
`BallastHook`, or any other gen-4 contract.

---

## 1. Phase 1 — research findings

### 1.1 Current treasury contract(s)

`contracts/src/ProjectTreasury.sol` — one per token, deployed by
`BallastFactory.launch()` (`contracts/src/BallastFactory.sol:370`) in the same
transaction as the token itself. Access control, quoted directly:

- **Creator (withdrawable) deposits**: `onlyCreator`, `deposit()` (`ProjectTreasury.sol:180`).
  Creator may later `announceWithdrawal`/`executeWithdrawal` (`:274`, `:292`),
  gated by the immutable `noticePeriod` (`:39`) — creator can only ever
  withdraw what they themselves put in (`creatorWithdrawable`, `:67`).
- **Third-party deposits**: anyone may `proposeDeposit()` (`:202`), but funds
  only count once the creator `acceptDeposit()`s them (`:226`), at which point
  they move to `lockedBalance` (`:71`) — **permanently locked, no withdrawal
  function exists for this bucket, for anyone, ever** (contract-level doc
  comment, `:23-25`). This is the structural reason Open Treasury must be a
  new contract: "depositor gets their own principal back" is impossible to
  retrofit onto a bucket that is locked by design.
- Self-backing blocked: `require(asset != projectToken)` (`_validateAsset`,
  `:359`), asset must be `registry.isAllowed()` (`:361`), amount must clear
  `registry.minDeposit(asset)` (`:362-363`).

So: **one ProjectTreasury per token, not shared**; creator-only withdrawal
path; third-party path is one-way (deposit, never withdraw).

### 1.2 BackingLens pricing

`contracts/src/BackingLens.sol`. `backingOf(treasuryAddr)` (`:91`) is the
single batched read the frontend calls. Per asset (`_valueAsset`, `:143`):

1. Reads the feed address via `registry.feedOf(asset)` (`:155`) — if unset
   (delisted after deposit), reports unpriced, never reverts (`:156`).
2. Calls `feed.latestRoundData()` inside a `try/catch` (`_tryReadFeed`,
   `:196`) — a reverting or zero/negative-answer feed is reported `priced =
   false`, never reverts the whole call (`:162`).
3. Reads `feed.decimals()` live, never hardcoded (`:206-208`, hard rule 9).
4. Staleness is a **flag**, not a revert: `stale = (block.timestamp -
   updatedAt) > registry.staleAfter(asset)` (`:164`) — the asset still prices
   and counts toward totals even when `stale == true`; only a genuinely
   invalid/reverting feed (`ok == false`) is excluded from totals
   (`priced = false`).
5. USD conversion (`_toUsd`, `:174`): `balance * price * 1e18 / (10^assetDec *
   10^priceDec)` — decimals read live from both the asset and the feed, never
   hardcoded.
6. Sequencer: `sequencerUptimeFeed` is optional (`constructor`, `:86-88`); when
   unset, status is `Unknown` and prices are **still trusted** (`:102`,
   `trustPrices` true for `Up` or `Unknown`). Chain 4663 has none configured
   today.

**Price source for Open Treasury's weighting = the exact same path**:
`registry.feedOf(asset)` → `AggregatorV3Interface.latestRoundData()` +
`.decimals()`, same `registry.staleAfter(asset)` bound. Open Treasury does
**not** call `BackingLens` itself for pricing (no treasury-shaped object to
hand it — a vault isn't a `ProjectTreasury`) — it reads the registry and feed
directly, identically to how `BackingLens._valueAsset` does, so "same pricing
source" is true at the implementation level, not just in spirit.

**Deliberate divergence from BackingLens's "never revert on stale" rule**:
hard rule 6 governs *valuation display* — a read-only call that must never
brick because an off-hours feed is resting. A deposit is a *state-changing
action that mints weight against new money*; minting weight off a stale or
invalid price is a real extraction risk BackingLens doesn't have (it never
mints anything). So Open Treasury's deposit path **does** revert on a stale or
invalid price — this is a different action with different risk, not a
violation of rule 6's intent. See §4 for the exact guard.

### 1.3 AssetRegistry — active assets, delisting

`contracts/src/AssetRegistry.sol`. `isAllowed(asset)` (`:108`) is checked at
deposit time by the one caller that exists today (`ProjectTreasury._validateAsset`,
`:361`) — Open Treasury does the same. `removeAsset()` (`:90`) deletes the
`Asset` struct entirely (`delete _assets[asset]`, `:102`) — so
`isAllowed()` flips to `false` and `feedOf()`/`staleAfter()` return zero
values immediately. The contract-level comment is explicit: **"Does not affect
assets already held by any treasury — deposits are validated at deposit time
only"** (`:88-89`). This is exactly rule 8's required shape and it is already
how `ProjectTreasury` behaves — Open Treasury inherits it for free by gating
new deposits on `isAllowed()` and never gating withdrawals on it at all.

### 1.4 Verifying a token was launched by BallastFactory

`contracts/src/BallastFactory.sol:118`: `mapping(address token => uint256
idPlusOne) public launchIdOf;` — written exactly once, inside `launch()`
(`:380`), never elsewhere. **`launchIdOf(token) != 0` is the authoritative,
unspoofable on-chain check**: it is state on the real, already-deployed
factory, not a claim the token contract makes about itself. (`BallastToken.factory`
(`BallastToken.sol:23`) is an immutable the token sets about itself in its own
constructor — a contract that never went through `launch()` could still hardcode
that field to the real factory's address and lie, so it is not a safe check on
its own; `launchIdOf` on the factory's own storage cannot be lied about by an
imitation token.) Open Treasury's factory verifies
`IBallastFactory(ballastFactory).launchIdOf(token) != 0` once, at vault-creation
time (§3), not on every deposit — the fact is permanent once true.

### 1.5 hook.claim() flow a creator uses today

`contracts/src/BallastHook.sol`. Confirmed **not** via FeeRouter (not deployed
— see conversation history). The only live path:

1. Every swap takes `feeConfig.feeBps()` (1%) of the quote-asset leg
   (`_feeOn`, `:283-285`).
2. `_distribute` (`:318`) splits that fee by `feeConfig.feeParams()`
   (`creatorBps`/`platformBps`/`referrerBps`) and, for a WETH-quoted pool,
   credits `owed[creator] += creatorCut` (`:336`) — a pull ledger, not a push.
3. The creator (an EOA today, for every live token — no FeeRouter wired to
   anyone) calls `BallastHook.claim()` (`:351`) themselves: `amount =
   owed[msg.sender]; owed[msg.sender] = 0; ... safeTransfer(msg.sender,
   amount)`. **Pays whoever calls it** — there is no "claim on behalf of"
   entrypoint, so only the creator's own wallet can ever pull this.
4. The creator now holds WETH in their own EOA. To fund Open Treasury rewards,
   they call `OpenTreasuryVault.notifyReward(amount)` themselves (§5,
   permissionless — works from this EOA with no special role) after
   `approve()`-ing the vault.

Non-WETH quote-asset fees use the parallel `owedIn`/`claimIn` ledger
(`:340`, `:359`) — dead code today (no non-WETH pools are live), same
pull-only shape.

### 1.6 Token page treasury rendering today

`web/components/app/BackingPanel.tsx` + `web/hooks/useBacking.ts`. The hook
resolves `treasury` via `token.treasury()` (`useBacking.ts:51-58`), then calls
`BackingLens.backingOf(treasury)` (`:118-125`). The panel
(`BackingPanel.tsx:60-132`) renders exactly **two** figures today — "Locked
forever" (`lockedValueUsd`/`lockedBackingPerToken`) and "Creator-withdrawable"
(`withdrawableValueUsd`, derived as `backingPerToken -
lockedBackingPerToken`) — as a split bar plus two stat blocks, with the
no-claim disclaimer rendered **inside** the panel (`:126-129`, hard rule 5).
Open Treasury adds a **third**, visually and semantically separate section
(§8) — it must never be folded into this existing split bar, which is exactly
rule 18's requirement (community deposits "never shown as a fixed reserve or
folded into an unlabelled backing number").

RPC was reachable for this round (prior conversation already confirmed public
RPC availability) — no facts in this section are unverified; everything above
is read from source.

---

## 2. Decisions made while designing (brief said: apply the rules, pick the
   most conservative option, record decision + reason, continue)

| # | Choice point | Decision | Reason |
|---|---|---|---|
| D1 | Weighting mechanism | USD value at deposit time via the registry's Chainlink feed (same source BackingLens uses) | No oracle-free alternative is actually *fair* across heterogeneous assets sharing one WETH reward stream — see §4.0 for the full argument for why this is the least-bad option, not a default reached without looking for alternatives. |
| D2 | Reward streaming shape | Synthetix-style **linear** `rewardRate`/`periodFinish` stream (not `HolderStakingVault`'s instant-fold model) | `HolderStakingVault.notifyReward` folds a reward into `rewardPerTokenStored` **instantly**, which is trivially snipeable (deposit the block before a big notify, claim the block after). The brief requires linear streaming precisely to close that; `HolderStakingVault`'s shape is deliberately not reused here. |
| D3 | Per-(depositor, asset) holding-time tracking | A single `lastDepositAt[depositor][asset]` timestamp that **resets on every top-up of that asset**, not a per-deposit FIFO ledger | A FIFO ledger is more precise but needs an unbounded, per-user array (gas grows with a user's own deposit count — a self-inflicted but real gas-bomb risk) and loops on withdrawal. A single reset timestamp is simpler, has no loop, and is strictly *more* conservative (a top-up relocks the whole balance, never less safe than FIFO) — the brief says pick the conservative option. |
| D4 | Dust minimum | Reuse `AssetRegistry.minDeposit(asset)` verbatim — no new per-asset config | Already decimals-correct per asset, already owner-maintained, and reusing it means Open Treasury's dust bar can never drift from the bar the rest of the product already trusts for the same asset. No new constant to invent or keep in sync. |
| D5 | Price staleness bound | Reuse `registry.staleAfter(asset)` (same bound BackingLens uses) | Same reasoning as D4 — one source of truth for "how stale is too stale" per asset, owner-maintained, not duplicated. |
| D6 | Extra sanity guard beyond staleness | A per-asset last-seen-price circuit breaker: reject a deposit if the newly read price has moved more than `MAX_PRICE_DEVIATION_BPS` (2000 = 20%, immutable) from the last price this contract itself observed for that asset | Chain 4663 has no second price source to cross-check against (no TWAP oracle for v4 pools — CLAUDE.md). A single-feed deviation breaker is the only implementable sanity check without inventing a new oracle dependency. 20% mirrors the existing `MAX_SLIPPAGE_BPS = 2_000` ceiling already used in `FeeRouter.sol`/`BuybackBurnerV2.sol` for the same "conservative outer bound" purpose — reusing an already-precedented magnitude in this codebase rather than inventing a new one. First-ever priced deposit for an asset has no prior price to compare against and is accepted as the baseline (documented, not a gap anyone can exploit twice — the second deposit onward is always checked). |
| D7 | Deposit entrypoint shape | Factory only **creates** vaults (`getOrCreateVault`, permissionless, idempotent, zero caller-supplied economic parameters); depositors call `deposit()` **directly on the vault** (approve the vault's deterministic address, not the factory) | Keeps the vault's `msg.sender` always the real, directly-interacting caller — no relay trust needed, no `onlyFactory`-gated `depositFor` surface to get wrong. Every vault this factory creates is configured identically (only `token` varies, no caller-chosen bps/params), so front-running vault creation is a provable non-issue (§9.9) — unlike the Ramses splitter case from the prior work item, there is no economic parameter here for a front-runner to grief. |
| D8 | Self-backing | Block `asset == token` in `deposit()`, same as `ProjectTreasury._validateAsset` | Not explicitly restated in the brief's product rules, but CLAUDE.md hard rule 13 ("require(asset != projectToken) — self-backing must be impossible") is a *global* rule, not scoped to `ProjectTreasury`. Applied here for the same reason it exists there: a token cannot be "backed" by itself without being circular and wash-tradeable. |
| D9 | Holding time value | Keep 24 hours (the brief's own starting point) | Its purpose is narrow: kill same-day "deposit for a screenshot/announcement, withdraw right after" optics manipulation (threat §9.9) and give observers a full day to notice an unusual deposit before it could be reversed. Principal is always 1:1 redeemable regardless of hold time — this is not a funds-safety parameter, so extending it further only adds depositor friction without closing any additional identified exploit. 24h is long enough for its actual job and short enough that this stays a deposit/withdraw product, not a lockup. |
| D10 | Reward stream period | Keep 7 days (the brief's own starting point) | Short enough that rewards feel responsive to real fee activity and a late depositor doesn't share a long dilution window; long enough to smooth lumpy, manually-triggered `notifyReward` calls (there is no automatic keeper) without needing constant manual top-ups. A 1-day period would make the stream reset too often relative to how often a creator will realistically remember to claim-and-fund; a 30-day period would make rewards feel stale. 7 days is the brief's own suggested value and nothing in the threat model argues for a different one. |
| D11 | Zero-weight reward rule | **Hold**, not return (rule 16's two options) | Returning forces the vault to track and refund a specific notifier later (another ledger, another withdrawal path, another "who gets it back" question). Holding in a single `pendingReward` accumulator and folding it into the stream the instant `totalWeight` first becomes nonzero is simpler, has one fewer state machine, and matches the *existing, already-reviewed* pattern `HolderStakingVault.notifyReward` already uses for the identical zero-stake edge case (`HolderStakingVault.sol:111-117`) — consistency with a pattern already in production beats inventing a second one. |
| D12 | `sync()` principal/reward separation | Track `totalPrincipal[asset]` (global, per asset) and `totalRewardDeposited − totalRewardClaimed` (global, reward-asset only) as two independent running totals; `sync()`'s surplus = `balanceOf(address(this)) − totalPrincipal[rewardAsset] − (totalRewardDeposited − totalRewardClaimed)` | This is the only shape where a plain principal deposit of the reward asset (if the reward asset is ever also depositable) and a plain reward transfer-in are structurally distinguishable without `sync()` having to guess intent — see §4.4 for the full argument and the explicit test this ships with. |

---

## 3. Architecture

Three new contracts, fully additive, zero changes to any existing file:

```
OpenTreasuryVaultFactory  (singleton, permissionless, no owner)
   │ cloneDeterministic (EIP-1167, salt = token address)
   ▼
OpenTreasuryVault  (one per token, created lazily on first getOrCreateVault call)
   — deposit / withdraw / claim / notifyReward / sync, all direct, no relay

OpenTreasuryLens  (singleton, read-only, composes the existing BackingLens
                    unmodified + reads OpenTreasuryVault state)
```

### 3.1 Why a minimal proxy clone (not a full deploy per token)

Same reasoning already applied to `BallastFeeSplitterFactory` in this
codebase: OZ's `Clones` (EIP-1167) is the already-vendored, industry-standard,
instantly-auditable pattern (`contracts/lib/openzeppelin-contracts/contracts/proxy/Clones.sol`).
A full `ProjectTreasury`-style per-token deploy would cost roughly 10x the gas
for no behavioral benefit — every vault's logic is identical, only `token`
varies. Config is set once via `initialize()` (one-shot guard, no setter
exists afterward for any of it) instead of a constructor, for the same reason
covered in the Ramses splitter design: clones share bytecode, so Solidity's
`immutable` keyword cannot hold per-clone values.

### 3.2 Deterministic addressing

`Clones.cloneDeterministic(implementation, salt)` where `salt =
bytes32(uint256(uint160(token)))` — the vault address for a given token is
computable off-chain (`Clones.predictDeterministicAddress`) **before** the
vault is created, exactly like the Ramses splitter's launcher-recognition
pattern needed deterministic addresses to reason about in advance. This lets
the frontend show/request an ERC-20 `approve()` to the vault's future address
before the vault technically has bytecode — standard CREATE2 pre-approval UX,
not a new pattern for this codebase's users (the same trick is already common
in CREATE2-based token-launch flows).

### 3.3 Deposit flow (two on-chain steps, usually one from the UI's point of view)

1. `OpenTreasuryVaultFactory.getOrCreateVault(token) → vault` — permissionless,
   idempotent (returns the existing vault if already created; see
   `vaultOf[token]`). Verifies `launchIdOf(token) != 0` on the real
   `BallastFactory` (§1.4) **once**, here, not on every deposit — the fact
   cannot become false later.
2. Depositor calls `vault.deposit(asset, amount)` directly (having approved
   the vault's address). Standard `msg.sender`-credits-self deposit — no
   relay, no `onlyFactory`-gated indirection, matching `ProjectTreasury`'s own
   style.

Most real deposits after the first one skip step 1 entirely once the frontend
already knows `vaultOf[token]` is set.

---

## 4. Weighting and pricing

### 4.0 Why USD-value weighting, and why nothing safer was found

A single WETH reward stream has to be split fairly across depositors who may
each hold a *different* asset (SGOV, NVDA, a $5 stock token, …) worth wildly
different amounts per unit. Two alternatives were considered and rejected:

- **Raw-amount weighting** (1 unit of any asset = 1 unit of weight,
  regardless of price) is not "safer," it is simply unfair — a depositor of a
  $600 stock token would earn the same reward share per token as a depositor
  of a $1 stablecoin-like asset. Rejected outright, not a real alternative.
- **Per-asset-isolated reward pools** (skip USD conversion by never combining
  assets — each asset's depositors only ever share rewards a human manually
  earmarks to that specific asset) avoids an oracle, but replaces a
  transparent on-chain formula with a creator's manual, undocumented
  judgment call every time they fund rewards. That is *worse*, not safer — it
  trades a known, already-depended-upon price feed for an opaque, discretionary
  split with no formula at all.

Given that, USD-value-at-deposit-time via the registry's Chainlink feed
introduces **no new trust assumption**: the product's headline number
("backing per token") already depends on these exact feeds via `BackingLens`.
If they were corruptible, the core product is already broken; depending on
them again for deposit weighting adds no new systemic risk surface.

### 4.1 Weight computed at deposit time, never re-read at withdrawal

```solidity
function _priceOf(address asset) internal returns (uint256 priceUsd1e18) {
    address feedAddr = registry.feedOf(asset);
    if (feedAddr == address(0)) revert AssetNotAllowed(asset); // delisted — can't newly deposit (rule 8)
    AggregatorV3Interface feed = AggregatorV3Interface(feedAddr);
    (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData(); // reverts bubble — deposit-time only, see §1.2
    if (answer <= 0) revert InvalidPrice(asset);
    if (block.timestamp - updatedAt > registry.staleAfter(asset)) revert StalePrice(asset, updatedAt);
    uint8 priceDec = feed.decimals();
    uint256 price = uint256(answer);

    uint256 last = lastPrice[asset];
    if (last != 0) {
        uint256 lo = (last * (BPS - MAX_PRICE_DEVIATION_BPS)) / BPS;
        uint256 hi = (last * (BPS + MAX_PRICE_DEVIATION_BPS)) / BPS;
        if (price < lo || price > hi) revert PriceDeviationTooLarge(asset, last, price);
    }
    lastPrice[asset] = price;

    uint8 assetDec = IERC20Metadata(asset).decimals(); // used by the caller to scale balance, not here
    priceUsd1e18 = price; // caller combines with assetDec via the same _toUsd shape BackingLens uses
}
```

(`_toUsd` is lifted verbatim from `BackingLens._toUsd` — same formula, same
rounding, same decimals-read-live discipline.)

`deposit()` reverts on `AssetNotAllowed`, `InvalidPrice`, `StalePrice`, or
`PriceDeviationTooLarge` — **the deposit never happens and no weight is ever
minted** on a bad read. This is the deliberate divergence from BackingLens
documented in §1.2.

### 4.2 Removing weight on withdrawal — no second price read, ever

Per depositor, per asset:

```
principal[depositor][asset]    // raw amount, asset decimals
assetWeight[depositor][asset]  // USD weight (1e18) this depositor contributed via THIS asset, cumulative across their deposits
```

On withdrawal of `amount` (`amount <= principal[depositor][asset]`):

```solidity
uint256 p = principal[depositor][asset];
uint256 w = assetWeight[depositor][asset];
uint256 weightRemoved = (w * amount) / p;       // proportional, floor-rounded
principal[depositor][asset] = p - amount;
assetWeight[depositor][asset] = w - weightRemoved;
totalWeight -= weightRemoved;
weightOf[depositor] -= weightRemoved;
```

A full withdrawal (`amount == p`) removes `weightRemoved == w` exactly (no
rounding loss — `w * p / p == w`). A partial withdrawal leaves proportionally
rounded-down dust in the remaining weight ratio, bounded and harmless — the
same category of floor-division dust already accepted elsewhere in this
codebase (e.g. `BallastFeeSplitter`'s creator-gets-the-remainder rule). No
price is read, no external call is made beyond the final token transfer — a
withdrawal can **never** be blocked by an oracle, satisfying rule 7's "a
withdrawal can never be blocked or redirected" together with rule 8's
"withdrawals of a delisted asset always work."

### 4.3 Reward accumulator — linear stream, Synthetix shape (D2)

```solidity
uint256 public immutable rewardsDuration; // 7 days
address public immutable rewardAsset;     // WETH

uint256 public periodFinish;
uint256 public rewardRate;          // rewardAsset units per second, undivided
uint256 public lastUpdateTime;
uint256 public rewardPerWeightStored; // 1e18 fixed point
mapping(address => uint256) public userRewardPerWeightPaid;
mapping(address => uint256) public rewards;       // accrued, claimable
uint256 public pendingReward;       // held while totalWeight == 0 (D11)

function lastTimeRewardApplicable() public view returns (uint256) {
    return block.timestamp < periodFinish ? block.timestamp : periodFinish;
}

function rewardPerWeight() public view returns (uint256) {
    if (totalWeight == 0) return rewardPerWeightStored;
    return rewardPerWeightStored
        + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * PRECISION) / totalWeight;
}

function earned(address account) public view returns (uint256) {
    return rewards[account]
        + (weightOf[account] * (rewardPerWeight() - userRewardPerWeightPaid[account])) / PRECISION;
}

function _updateReward(address account) internal {
    rewardPerWeightStored = rewardPerWeight();
    lastUpdateTime = lastTimeRewardApplicable();
    if (account != address(0)) {
        rewards[account] = earned(account);
        userRewardPerWeightPaid[account] = rewardPerWeightStored;
    }
}
```

`deposit`/`withdraw`/`claim` all call `_updateReward(msg.sender)` first
(checks-effects-interactions: accrue before changing weight or paying out).

### 4.4 Funding the stream — `notifyReward` and `sync` (rules 11, 12)

```solidity
function notifyReward(uint256 amount) external nonReentrant {
    if (amount == 0) revert ZeroAmount();
    IERC20(rewardAsset).safeTransferFrom(msg.sender, address(this), amount);
    _addReward(amount);
}

function sync() external nonReentrant returns (uint256 added) {
    uint256 bal = IERC20(rewardAsset).balanceOf(address(this));
    uint256 accounted = totalPrincipal[rewardAsset] + (totalRewardDeposited - totalRewardClaimed);
    if (bal <= accounted) return 0; // nothing unaccounted — in particular, principal deposits of rewardAsset never register here
    added = bal - accounted;
    _addReward(added);
}

function _addReward(uint256 amount) internal {
    totalRewardDeposited += amount;
    _updateReward(address(0)); // roll the accumulator forward to "now" before changing rate
    if (totalWeight == 0) {
        pendingReward += amount;
        emit RewardHeld(amount, pendingReward);
        return;
    }
    uint256 totalForStream = amount + pendingReward;
    pendingReward = 0;
    if (block.timestamp >= periodFinish) {
        rewardRate = totalForStream / rewardsDuration;
    } else {
        uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
        rewardRate = (totalForStream + leftover) / rewardsDuration;
    }
    lastUpdateTime = block.timestamp;
    periodFinish = block.timestamp + rewardsDuration;
    emit RewardAdded(totalForStream, rewardRate, periodFinish);
}
```

`deposit()` additionally checks, after updating weight: if `totalWeight` just
went from `0` to nonzero and `pendingReward > 0`, call `_addReward(0)` (folds
`pendingReward` into a fresh stream — D11's "start the stream when weight
becomes non-zero").

**Why `sync()` cannot mistake principal for reward (D12, rule 12's explicit
requirement)**: `totalPrincipal[rewardAsset]` is incremented inside `deposit()`
atomically with the same `safeTransferFrom` that moves the tokens in — a
principal deposit of the reward asset raises the vault's real balance and
`totalPrincipal[rewardAsset]` by the *exact same amount* in the *same
transaction*, so `bal - accounted` nets to the same value it was before,
*regardless of how much reward-asset principal sits in the vault*. The only
way `bal` can exceed `accounted` is tokens arriving **outside** the `deposit`
path — i.e. a plain transfer (the exact future-FeeRouter case rule 12 asks
for). This is tested explicitly: deposit reward-asset as principal, call
`sync()`, assert `added == 0`; separately plain-transfer extra tokens and call
`sync()`, assert the surplus is detected and streamed.

---

## 5. Storage layout

```solidity
// Immutable, set once in initialize() (clone — see §3.1 for why not `immutable`)
address public token;            // the project token this vault backs
address public factory;          // this vault's creating factory (view-only; no privileged calls gated to it)
address public registry;         // AssetRegistry
address public rewardAsset;      // WETH
uint256 public minHoldTime;      // 24 hours
uint256 public rewardsDuration;  // 7 days
bool    public initialized;

// Per-asset
mapping(address => uint256) public totalPrincipal;      // sum of all depositors' principal, this asset
mapping(address => uint256) public lastPrice;            // last observed feed price, this asset (D6 circuit breaker)

// Per depositor
mapping(address => mapping(address => uint256)) public principal;      // depositor => asset => raw amount
mapping(address => mapping(address => uint256)) public assetWeight;    // depositor => asset => USD weight (1e18)
mapping(address => mapping(address => uint256)) public lastDepositAt;  // depositor => asset => timestamp (D3)
mapping(address => uint256) public weightOf;                           // depositor => total USD weight, all assets
uint256 public totalWeight;

// Reward accumulator (§4.3)
uint256 public periodFinish;
uint256 public rewardRate;
uint256 public lastUpdateTime;
uint256 public rewardPerWeightStored;
mapping(address => uint256) public userRewardPerWeightPaid;
mapping(address => uint256) public rewards;
uint256 public pendingReward;
uint256 public totalRewardDeposited;
uint256 public totalRewardClaimed;
```

---

## 6. Functions (external surface)

`OpenTreasuryVaultFactory`:
- `getOrCreateVault(address token) external returns (address vault)` — permissionless, idempotent.
- `vaultFor(address token) external view returns (address)` — deterministic prediction, works pre-creation.
- `vaultOf(address token) external view returns (address)` — zero if not yet created.

`OpenTreasuryVault`:
- `initialize(address token_, address factory_, address registry_, address rewardAsset_, uint256 minHoldTime_, uint256 rewardsDuration_) external` — one-shot, called by the factory in the same tx as the clone.
- `deposit(address asset, uint256 amount) external nonReentrant` — rules 1, 2, 3 (checked at vault-creation, not here), 5, 8, 14, D8.
- `withdraw(address asset, uint256 amount) external nonReentrant` — rules 6, 7, 8, 9, 14 (proportional removal), 15 (settles rewards first).
- `claim() external nonReentrant returns (uint256)` — rule 15.
- `claimFor(address depositor) external nonReentrant returns (uint256)` — rule 15's explicit "fine if it can only pay the depositor" — pays `depositor`, not `msg.sender`; anyone may call it, funds never leave to the caller.
- `notifyReward(uint256 amount) external nonReentrant` — rule 11.
- `sync() external nonReentrant returns (uint256 added)` — rule 12.
- Views: `earned(address)`, `pendingWithdrawAt(address depositor, address asset) returns (uint256 unlockAt)`, `assetsOf(address depositor) returns (address[] memory)` (for the frontend/lens to enumerate without indexing every possible asset).

`OpenTreasuryLens`:
- `combinedBackingOf(address token) external view returns (CombinedBacking memory)` — composes the **unmodified** `BackingLens.backingOf(token.treasury())` with the vault's own per-asset principal, valued through the same registry/feed path, never writing to or calling any mutating function on either.

---

## 7. Events and custom errors

Events: `VaultCreated(address indexed token, address indexed vault)`,
`Deposited(address indexed depositor, address indexed asset, uint256 amount, uint256 weight)`,
`Withdrawn(address indexed depositor, address indexed asset, uint256 amount, uint256 weightRemoved)`,
`Claimed(address indexed depositor, uint256 amount)`,
`RewardAdded(uint256 amount, uint256 rewardRate, uint256 periodFinish)`,
`RewardHeld(uint256 amount, uint256 totalPending)`,
`Synced(uint256 added)`.

Errors: `AlreadyInitialized`, `ZeroAddress`, `ZeroAmount`, `SelfBacking`,
`AssetNotAllowed(address)`, `BelowMinimum(uint256,uint256)`,
`NotLaunchedToken(address)`, `InvalidPrice(address)`,
`StalePrice(address,uint256)`, `PriceDeviationTooLarge(address,uint256,uint256)`,
`InsufficientBalance(uint256,uint256)`, `StillLocked(uint256)`,
`NothingToClaim`.

---

## 8. Lens interface + display (rule 18)

```solidity
struct CombinedBacking {
    uint256 creatorFundedUsd;      // == BackingLens.backingOf(treasury).totalValueUsd, passthrough, unmodified source
    uint256 communityWithdrawableUsd; // new: sum of vault principal, priced live
    uint256 combinedTotalUsd;      // creatorFundedUsd + communityWithdrawableUsd — informational only, never backing-per-token
    bool creatorFundedAnyStale;
    bool communityAnyStale;
    AssetView[] communityAssets;   // per-asset: principal balance, USD value, priced/stale flags — same shape as BackingLens.AssetBacking
}
```

The frontend renders three figures per rule 18: "Creator-funded treasury"
(existing `BackingPanel`, untouched), "Community deposits — withdrawable" (new
section, §10), and "Combined total" (sum, labelled, never substituted for
either individual figure and never fed into `backingPerToken`). `combinedTotalUsd`
is explicitly *not* a new backing-per-token denominator — `BackingLens`'s own
`backingPerToken` stays computed exactly as it is today, unchanged.

---

## 9. Threat model

**Reentrancy via a malicious asset.** `nonReentrant` (OZ `ReentrancyGuard`,
single shared lock across the whole contract, matching `ProjectTreasury`/
`FeeRouter`/`BuybackBurnerV2` style) on every state-changing function.
Deposit/withdraw/claim/notify/sync all follow checks-effects-interactions —
state is updated before any external call. Tested with the same
`ReentrantERC20` mock pattern used for the Ramses splitter.

**Fee-on-transfer and rebasing assets.** Deposit credits `balanceOf(before)` →
`transferFrom` → `balanceOf(after)` delta, never the requested `amount` — an
inbound fee is absorbed correctly, phantom weight is never minted for tokens
that never arrived. Withdrawal does not need the same treatment: a plain
`transfer(to, amount)` always debits the **sender** (the vault) by exactly
`amount` regardless of any fee the token takes on the **receiving** side, so
vault accounting (`principal -= amount`, real balance `-= amount`) always
stays exactly in sync — see §4's "vault always covers withdrawals" reasoning,
confirmed by the fee-on-transfer mock test. Ongoing rebasing (balance changes
with no transfer) is out of scope for the actual in-scope asset class —
ERC-8056 stock tokens are explicitly non-rebasing by architecture (CLAUDE.md:
"corporate actions move `uiMultiplier()` instead of balances") — but nothing
here *assumes* a specific asset is well-behaved beyond the registry's own
allowlisting; a hypothetical rebasing asset would just accumulate accounting
drift identical to any other protocol that doesn't special-case rebasing,
which the registry's owner-curated allowlist (not this contract) is the actual
control for.

**Reward sniping around `notifyReward`.** Structurally bounded by the linear
stream itself (D2) — `earned()` only ever materializes the *time-integrated*
share a depositor's weight actually held, not a lump-sum cut of whatever
`rewardRate` happens to be at claim time. Depositing one block before a large
`notifyReward` and withdrawing the moment `minHoldTime` allows earns that
depositor's weight-share of the stream for the elapsed holding period only —
mathematically bounded, not merely discouraged. Tested explicitly (§Phase 4).

**Price manipulation at deposit to gain weight.** The depositor is
transferring a *real* amount of the *real* asset — gaining outsized weight
would require the asset's own market price to be genuinely, sustainedly
inflated (expensive, not a flash-loan-style single-block exploit, since
Chainlink feeds are off-chain-sourced and not derived from an on-chain pool
this contract or an attacker can move within one transaction). The residual
risk is a **feed** reporting a wrong number, not the depositor manipulating
anything themselves — covered by the staleness bound (§4.1) and the D6
deviation circuit breaker, which bounds the blast radius of any single bad
round to `MAX_PRICE_DEVIATION_BPS` relative to the last price this contract
itself observed.

**Stale prices.** Hard revert at deposit time (§4.1) — never mints weight off
a price older than `registry.staleAfter(asset)`. Withdrawal never reads a
price at all (§4.2), so staleness can never block a withdrawal (rule 7/8).

**Unlisted tokens sent by plain transfer.** A plain `IERC20.transfer` straight
to the vault (bypassing `deposit()`) credits **nothing** — `principal`,
`assetWeight`, and `totalWeight` are only ever written inside `deposit()`.
Such tokens simply sit in the vault's balance, unaccounted and un-owed to
anyone, exactly like an accidental transfer to any contract without a sweep
function — there is deliberately no rescue function (rule 7 forbids one), so
this is an accepted, documented gap: a mis-sent token is unrecoverable by
design, the same tradeoff already accepted for the Ramses splitter's stuck
pull-fallback dust.

**Dust spam.** `BelowMinimum` revert on every deposit below
`registry.minDeposit(asset)` (D4) — the exact bar the rest of the product
already uses for the same assets.

**Front-running vault creation.** A provable non-issue: `getOrCreateVault`
takes no caller-supplied economic parameter — every vault from this factory
is configured identically regardless of who calls creation first (only
`token` varies, and `token` is the thing being looked up, not a free choice).
Whoever calls it first gets the exact same result as whoever would have
called it second.

**Depositing to look better-backed, then withdrawing.** This is why
`minHoldTime` exists (D9) — 24 hours is enough that a deposit timed to
coincide with a specific announcement or screenshot cannot be reversed within
the same news cycle, while never blocking genuine withdrawal of real
principal indefinitely. Because `OpenTreasuryLens` labels this figure
"withdrawable" and keeps it visually separate from `backingPerToken` (§8,
rule 18), there is also no single combined number this behavior could distort
in the first place — the honest display design is itself a mitigation, not
just the time lock.

**Asset delisting or depeg.** Delisting: new deposits of that asset revert
(`isAllowed` gate), existing withdrawals are entirely unaffected (§4.2 never
re-checks `isAllowed` or re-reads a price) — rule 8, satisfied structurally.
Depeg: this contract has no automated response to a depeg (no liquidation, no
margin call — it isn't that kind of product); a depegged asset's *weight*
stays frozen at whatever it was priced at deposit time (by design — §4.2 never
re-prices), which means reward *share* does not silently shift due to a
depeg, but it also means the lens's live-priced `communityWithdrawableUsd`
figure (§8, which DOES re-price for display, unlike weight) will honestly show
a lower USD value for a depegged asset even though the depositor's weight
(and therefore reward share) is unaffected — this divergence between "display
value" and "reward weight" is intentional and should be called out in the UI
copy if it ever becomes visible (not building UI copy for a hypothetical
depeg beyond what the existing stale/unpriced chips already communicate).

**Any displayed number that could mislead.** Covered by rule 18's three-figure
separation (§8) plus the existing `BackingPanel` conventions this reuses
wholesale (stale/unpriced chips, sequencer-unverifiable chip, no fake greens,
timestamp glued to its figure). Nothing new is introduced that isn't already
this product's established display discipline.

---

## 10. Gas estimates (Phase 2 estimate — Phase 4 reports real `--gas-report` numbers)

| Operation | Estimate |
|---|---|
| `getOrCreateVault` (clone + initialize, first call) | ~180,000–220,000 gas (same order as the Ramses splitter's `createSplitter`, same clone pattern) |
| `getOrCreateVault` (vault already exists) | ~30,000 gas (one SLOAD, one external `launchIdOf` read skipped) |
| `deposit` (new asset for this depositor, priced) | ~150,000–220,000 gas (ERC20 transfer + feed read + several SSTOREs) |
| `withdraw` (partial) | ~90,000–130,000 gas |
| `claim` | ~60,000–90,000 gas |
| `notifyReward` | ~70,000–100,000 gas |
| `sync` | ~40,000–60,000 gas (no transfer, just a balance read + accounting) |

---

## 11. Open questions / risks carried into the final report

- No FeeRouter means `notifyReward` funding is entirely manual today — a
  creator has to remember to `claim()` then `notifyReward()`. The frontend's
  "Fund rewards" action (Phase 5) exists specifically to lower that friction,
  but there is no automated keeper, and this document doesn't propose one.
- The D6 price-deviation breaker only protects against a single bad round
  relative to this contract's own last observation — it cannot detect a
  *gradual*, multi-round drift toward a wrong price, nor can it do anything
  about a genuinely compromised upstream Chainlink feed (no second oracle
  exists on this chain to cross-check against — an existing, product-wide
  limitation, not new to Open Treasury).
- `OpenTreasuryLens.combinedBackingOf` depends on `BackingLens.backingOf`
  succeeding for the token's treasury — if that call reverts for an
  unexpected reason, the lens should surface "Unknown" for the creator-funded
  figure rather than reverting the whole combined read (implemented as a
  `try/catch` around that one external call, same `try`-based defensiveness
  `BackingLens` itself already uses internally).
