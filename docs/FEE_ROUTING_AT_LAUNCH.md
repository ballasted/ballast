# Fee routing at launch — Phase 1 research

Status: **PARKED (2026-10-09)** — needs new contracts, not building or deploying
anything for this right now. Research only, nothing built or changed. Written per
the task's explicit "report before building, stop for approval" instruction. No
gen-4 contract (factory, hook, seeder, FeeConfig) was touched or needs to be.

Re: §6's `CreatorWithdrawalPanel` bug — confirmed low priority for now: it only
affects router-backed tokens, and no router-backed token exists (`FeeRouterFactory`
has never been deployed, `NEXT_PUBLIC_FEE_ROUTER_FACTORY_ADDRESS` is unset). Left
unfixed. Revisit if/when this feature is unparked.

## 1. Can the creator/fee recipient be set to something other than `msg.sender`? Is it fixed forever?

No, and yes, respectively.

`BallastFactory.launch()` (`contracts/src/BallastFactory.sol:367-370`) does:

```solidity
BallastToken t = new BallastToken(name_, symbol_, TOTAL_SUPPLY, msg.sender, address(this), metadataURI);
ProjectTreasury tr = new ProjectTreasury(address(t), msg.sender, noticePeriod, registry);
```

Both `BallastToken.creator` and `ProjectTreasury.creator` are `immutable`, and both are set
to the **same** `msg.sender` — whoever directly calls `launch()` — in the same
transaction. There is no parameter to set a different address, and no setter exists
afterward on either contract. Once set, creator identity cannot change for the life
of the token.

Critically, "whoever calls `launch()`" is not necessarily an EOA. If a contract calls
`BallastFactory.launch()` itself (rather than an EOA calling it directly), **that
contract** becomes `creator` on both `BallastToken` and `ProjectTreasury`. This is the
entire mechanism the existing `FeeRouter` design already relies on (see §3).

## 2. Every privilege tied to the creator address

Grepped all of `contracts/src` for creator-gating; five files matched. Three are the
gen-4 set in scope here, one is `FeeRouter` (which already covers them — see §3), one
(`BallastFeeSplitter.sol`) is the unrelated Ramses-locked-pool track and out of scope.

| Contract | Function | Gate |
|---|---|---|
| `BallastToken` | `setMetadataURI` | `onlyCreator` |
| `ProjectTreasury` | `deposit` | `onlyCreator` |
| `ProjectTreasury` | `acceptDeposit` | `onlyCreator` |
| `ProjectTreasury` | `declineDeposit` | `onlyCreator` |
| `ProjectTreasury` | `announceWithdrawal` | `onlyCreator` |
| `ProjectTreasury` | `executeWithdrawal` | `onlyCreator` |
| `ProjectTreasury` | `cancelWithdrawal` | `onlyCreator` |
| `BallastHook` | `claim()` / `claimIn(currency)` | permissionless pull, but `owed[x]`/`owedIn[x][currency]` only ever accrues to `x = BallastToken(token).creator()` — so only the address matching that immutable field can ever have a balance to pull |

`proposeDeposit` is permissionless by design (anyone can propose a third-party
deposit) and isn't creator-gated, so it's not in this list.

If a router contract becomes `creator`, every row above stops answering to the human's
wallet directly — only the router's own address satisfies `onlyCreator` / accrues
`owed[]`. Nothing may get locked out means the router must re-expose every one of
these to the real human, authenticated against a separately-stored "real creator"
address.

## 3. The existing FeeRouter — already built, and it already solves this

`contracts/src/FeeRouter.sol` + `FeeRouterFactory.sol` (fork-tested, never deployed)
turn out to already be a complete answer to §1 and §2, and the frontend integration
for it is **already substantially built** (this surprised me — it predates my visible
context window). Current state:

**Contracts.** `FeeRouterFactory.createAndLaunch(...)` is the stateless launch helper
point 4 of the task asks for: it deploys a dedicated per-token `FeeRouter`
(immutable `realCreator` = the human's wallet) and that router immediately calls
`BallastFactory.launch()` **itself**, becoming the on-chain `creator` of both the
token and the treasury in the same transaction. `FeeRouter` then re-exposes every
row from the §2 table as a passthrough, `onlyRealCreator`-gated:
`creatorDeposit`, `acceptDeposit`, `declineDeposit`, `announceWithdrawal`,
`executeWithdrawal` (auto-sweeps the payout from the router to `realCreator` — the
treasury pays out to `creator`, which is the router, so this matters),
`cancelWithdrawal`, `setMetadataURI`. Nothing in the §2 table is missing a
passthrough. `route()` is permissionless and pulls whatever the router is owed as
the recorded creator via `claim()`, then splits it across up to four buckets
(current code): creator wallet / treasury-asset-swap-and-lock-forever / buyback
&burn / a per-token `HolderStakingVault` it auto-deploys. `routeIn(currency)` handles
every non-WETH (`claimIn`) fee today by forwarding 100% to `realCreator` — nothing
is ever stranded, satisfying the task's "stock-quoted fees must have a path too."
Split changes go through `scheduleSplit`/`applySplit`, a flat 7-day delay, never
skippable — matches the constraint.

**Frontend — already built, currently dead code.** `NEXT_PUBLIC_FEE_ROUTER_FACTORY_ADDRESS`
is unset, so all of this is inert in production today (confirmed: the string isn't
inlined in the live bundle). But the code exists:
- `web/components/app/create/FeesSection.tsx` — the bucket-split picker on
  `/app/create`. Four presets (`All to me` / `Grow treasury` [disabled, "soon"] /
  `Buyback & burn` / `Reward stakers`) plus a custom slider. Choosing anything but
  "All to me" routes the launch through the router path.
- `web/hooks/useFeeRouterLaunchRunner.ts` — full orchestration: deploy router +
  launch (atomic), schedule the chosen split, and — if the creator wants to seed a
  backed launch — approve the **router** (not the treasury) and call its
  `creatorDeposit` passthrough, with the correct comment explaining why a direct
  `treasury.deposit()` would revert `NotCreator`.
- `web/components/app/token/FeeRouterDashboard.tsx` / `FeeRouterCard.tsx` /
  `useFeeRouter.ts` — creator control panel (schedule a new split, trigger `route()`)
  and a public read-only view. The dashboard correctly keys its `isCreator` check off
  `state.realCreator`, not the raw on-chain `creator` — i.e. this file already got
  the router-identity distinction right.
- `web/components/app/token/StakingPanel.tsx` — UI for the auto-deployed
  `HolderStakingVault` (stake-the-project-token model). Never exercised against a
  live vault (router never deployed).

So the shape the task asks about — "router as creator, permissionless claim +
distribute, destinations wallet / Open Treasury vault / buyback-and-burn" — is not a
new system to design. It is 90% of an existing, fork-tested system whose current
4th bucket targets the wrong vault type for what's being asked now.

## 4. Fitting the Open Treasury vault in

The gap: today's "4th bucket" auto-deploys a bespoke `HolderStakingVault` per token
(stake-the-project-token, never deployed anywhere, zero live users). The task wants
that money going to `OpenTreasuryVault` instead — the vault type that's been live in
production since earlier today (deposit any listed asset, pro-rata WETH reward
stream, no staking of the project token involved). Concretely:

- `OpenTreasuryVaultFactory.getOrCreateVault(token)` (factory `0xF2B171DF729fd6701553610732eB43d13417e1d9`)
  is idempotent and permissionless — safe to call every `route()`, matching "vault
  created on demand."
- `OpenTreasuryVault.notifyReward(uint256 amount)` is **pull-based**
  (`safeTransferFrom(msg.sender, ...)`), so the router would need to `forceApprove`
  the vault before calling it — the exact same approve-then-call pattern
  `_routeTreasury` already uses for the treasury bucket. There's also a permissionless
  `sync()` (plain transfer, then anyone can call `sync()` to register the surplus as
  reward) — the vault's own docstring calls this out as the anticipated FeeRouter
  integration path. Either works; I'd recommend `forceApprove` + `notifyReward` for
  atomicity (the stream starts in the same call, not dependent on a second caller
  noticing the surplus), consistent with the router's existing style.
- No chicken-and-egg problem: unlike the treasury-asset-swap bucket (needs a
  `PoolKey` at construction) or the buyback bucket (needs `graduate()` to have
  happened), the Open Treasury vault only needs the token's own address, which is
  already known before `route()` is ever called.
- **This needs no new frontend UI.** `web/components/app/token/OpenTreasurySection.tsx`
  already renders deposit/withdraw/claim/reward-stream for any token once its vault
  exists — the copy was just corrected today to say rewards "depend on what is sent
  to this vault" rather than implying automatic trading fees. The moment a router
  calls `notifyReward` on a token's vault, depositors see "Total distributed" and
  the live stream update with zero new frontend work. This is strictly less surface
  than finishing/shipping `StakingPanel.tsx` against a vault type that's never been
  deployed or tested live.

**Open question for you, not decided here:** the task names exactly three
destinations (wallet / Open Treasury / buyback), which doesn't mention the existing
"treasury bucket" (swap-and-lock-forever into `treasuryAsset`) at all. That bucket is
already disabled in the UI today ("soon") for an unrelated reason (no client-side
pool-key resolution yet) — nothing requires a decision about it to ship this feature.
I'd leave it as-is (present but disabled) unless you want it removed outright. The
only real decision is: **retarget the 4th bucket from `HolderStakingVault` to
`OpenTreasuryVault`**, which I'd recommend doing by replacing the bucket (not adding
a 5th), since `HolderStakingVault` has never shipped to a single live user and the
two products (stake-the-token vs. deposit-any-asset) aren't something the create flow
should ask a creator to choose between.

## 5. What changes for the user

- **Creator picks "All to me" (today's only live behavior, default preset):**
  nothing changes. Launch still calls `BallastFactory.launch()` directly, creator is
  the EOA, identical to today.
- **Creator picks any other split:** launch goes through
  `FeeRouterFactory.createAndLaunch()` instead. The on-chain `creator` of both the
  token and the treasury becomes a dedicated router contract, not the EOA — this is
  **permanent for the life of the token** (§1). The human's wallet (`realCreator`)
  retains every privilege it would have had directly, but must exercise all of them
  — metadata updates, treasury deposit/withdrawal lifecycle, fee claiming — through
  the router's passthrough functions instead of calling `BallastToken`/
  `ProjectTreasury`/`BallastHook` directly. Only the **split percentages** can be
  changed after the fact, and only with the 7-day delay — never the destinations or
  the router identity itself. This permanence isn't currently disclosed anywhere in
  `CreateFlow.tsx`'s confirm screen; it should be before this ships.

## 6. A real gap I found while tracing this, not asked for but blocking

`web/components/app/CreatorWithdrawalPanel.tsx` (creator-only treasury withdrawal
controls, rendered on the token page) checks:

```ts
const isCreator = Boolean(account && creator && account.toLowerCase() === creator.toLowerCase());
```

...against the raw on-chain `creator` it's passed. For a router-backed token,
on-chain `creator` **is the router's address**, which no EOA will ever equal — so
this panel would silently never render for the real human, who would have no
visible way to announce/execute/cancel a withdrawal of their own treasury deposit.
`FeeRouterDashboard.tsx` already solved exactly this by checking against
`state.realCreator` instead; `CreatorWithdrawalPanel.tsx` needs the same treatment
(detect a router-backed token, compare against its `realCreator`, and write through
`router.announceWithdrawal/executeWithdrawal/cancelWithdrawal` instead of calling
`ProjectTreasury` directly). This must be fixed before shipping fee routing at
launch, or the very first creator who picks a non-default split loses visible access
to their own withdrawal controls.

## 7. Confirmed, not assumed

- Live `FeeConfig.feeParams()` on-chain right now: `feeBps=100` (1%), `creatorBps=8000`
  (80%), `platformBps=2000` (20%), `referrerBps=0`. Matches the task's "80% creator
  share" exactly — read live, not hardcoded anywhere in this doc's reasoning.
- `routeIn()` (non-WETH/stock-quoted fees) already forwards 100% to `realCreator`
  today — nothing stuck, no bucket split for these yet (documented limitation, not a
  bug); extending bucket-splitting to non-WETH fees is a separate, larger project if
  ever wanted and isn't required for this feature.

## Proposed scope (for your approval, nothing built yet)

1. `FeeRouter.sol`: replace the auto-deployed `HolderStakingVault` 4th bucket with
   calls into `OpenTreasuryVaultFactory.getOrCreateVault(token)` +
   `forceApprove` + `notifyReward`. Remove the `HolderStakingVault` deploy from
   `_wire()`. No change to the other three buckets, the passthrough surface, or the
   7-day split-delay mechanism.
2. `FeeRouterFactory.sol`: no change needed — it's a thin deployer, doesn't reference
   the bucket internals directly.
3. Frontend: rename the "Reward stakers" preset/label to "Open Treasury" in
   `FeesSection.tsx`; retire `StakingPanel.tsx` (superseded by the already-live
   `OpenTreasurySection.tsx`, which needs no changes to work with this); fix
   `CreatorWithdrawalPanel.tsx`'s `isCreator` check (§6); add a one-line disclosure
   to `CreateFlow.tsx`'s confirm screen that choosing a split makes the router the
   permanent on-chain creator.
4. Copy: "fee share," never "dividend"/"passive income"/"guaranteed"/projected APR —
   already the house style and already followed by the existing `FeesSection.tsx`/
   `OpenTreasurySection.tsx` copy.
5. Re-run the full fork suite (including the existing `FeeRouter` fork tests) after
   the bucket swap, plus `tsc`/`vitest`/`next build` for the frontend changes, before
   any deploy is discussed.

Stopping here for your go-ahead before writing any contract or frontend code.
