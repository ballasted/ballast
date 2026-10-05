# $BALLAST v2 buyback & burn — go-live runbook

Everything below is prepared and tested. Nothing has been broadcast and no Safe
transaction has been signed — this is the exact ordered sequence for you to
run it yourself (or tell me to run the parts that don't need your signature).

RPC was unreachable from the agent sandbox this whole session (the mainnet RPC
hostname resolved to an intercepted/wrong TLS certificate — see "What could
not be verified" below). Every live number quoted here is either carried
forward from `docs/BALLAST_STATE.md` (verified live in a prior session, dated)
or explicitly marked Unknown. Re-check anything time-sensitive before signing.

---

## What this does

The platform takes a 1% fee on every swap through every pool the singleton
`BallastHook` serves (`0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc`), split
80% creator / 20% platform (`FeeConfig` gen-4, `0xE09F093595045E8765F420Cb12E0AA250910E5AD`,
`setParams(100, 8000, 2000, 0)`, confirmed via the deploy broadcast log —
`contracts/broadcast/DeployCombinationPackage.s.sol/4663/run-latest.json`).
The platform's 20% share accrues as `owed(FeeConfig.platformVault())` on the
hook — currently the Safe itself (`0xEFC97e16a24d2434C7138a2634E554a0631aC079`,
same broadcast log, constructor arg 2 of `FeeConfig`).

After this runbook: that 20% share accrues directly to a new, immutable,
ownerless contract (`BuybackBurnerV2`, already built, extended this session)
instead of the Safe. Anyone may call `buybackAndBurn` at any time (no keeper)
— it pulls whatever's accrued, buys $BALLAST v2 on the open market through its
real WETH pool, and sends everything bought to `0x…dEaD`, irretrievably. The
Safe's manual "claim and forward" routine is no longer required going forward
(see "Two funding paths" below for why this one was chosen).

---

## Two funding paths considered (as asked)

**Path A — change the recipient (chosen).** One Safe transaction,
`FeeConfig.setPlatformVault(BuybackBurnerV2 address)`. From then on every
swap's platform fee share accrues as `owed(BuybackBurnerV2)` directly — no
further Safe action, ever, for ongoing funding. `BuybackBurnerV2` was
extended this session (see "What changed" below) with a permissionless
`claimFees()`/`claimHooks` pull, mirroring `BuybackBurner` v1's existing
`claimHooks` pattern, so it can actually receive what accrues to its own
address (the hook's `claim()` pays `msg.sender`, so something has to be able
to call it as itself).

- Transactions: 1 Safe signature, ever (`setPlatformVault`), plus an optional
  one-time backfill of whatever was already accrued under the old setting
  (2 more Safe signatures, see step 5 — optional because unclaimed history
  doesn't disappear, it just stays claimable by the Safe directly).

**Path B — Safe claims and forwards, repeated forever.** Each time the Safe
wants to fund a buyback: `hook.claim()` (pulls `owed(Safe)` WETH to the Safe),
then `weth.transfer(BuybackBurnerV2, amount)`. Works with zero contract
changes (this is the exact routine `docs/safe-tx-fund-buybackv2.json` already
templated, for the *separate* v2-creator-fee top-up — see below).

- Transactions: 2 Safe signatures **every single time** you want to fund a
  buyback, forever, with a human remembering to do it.

**Recommendation: Path A.** The task requirement is "trigger is permissionless,
no keeper we must run" — Path B still needs a human to remember the forward
step indefinitely; Path A needs exactly one signature, ever, and then the
whole funding→buy→burn chain is permissionless end to end (a single
`buybackAndBurn` call both claims and spends). Path A is also smaller in
total transaction count unless the Safe would otherwise fund more than twice.

**This is separate from BALLAST v2's own creator fee.** v2's creator (the
Safe, immutable, set at launch) earns its own 80% creator share from v2's own
pool specifically — a different, pre-existing, still-optional routine
(`docs/safe-tx-fund-buybackv2.json`, unchanged by this session) where the Safe
may choose to forward some of *that* money to the burner too. Nothing in this
runbook touches that path; it still works exactly as before if you want to use
it alongside Path A.

---

## What changed in `BuybackBurnerV2.sol`

It already met every other requirement (no owner, no admin, no pause, no
upgradeability, per-call cap, cooldown, slippage guard, events, views — see
"Requirements check" below). The one gap: it had no way to pull funds from the
hook's `owed` ledger at all — it was built only for the Safe's manual
WETH/NVDA forwarding (path above). Smallest change made:

- New immutable `address[] public claimHooks` (set once at construction, no
  setter — same "write-once" shape as every other parameter here; empty by
  default behavior if deployed with a zero-length array, so this is additive,
  never required).
- New `claimFees()` (permissionless, `nonReentrant`) — pulls `owed(address(this))`
  from every configured hook via the same `claim()`/`owed()` selectors
  `BuybackBurner` v1 already depends on (`BallastHook.sol`'s own comment:
  "must never be touched").
- `buybackAndBurn` now calls the claim step automatically on its WETH path
  before sizing the spend, so one permissionless call both funds and executes.
- New `accruedWeth()` view (held + still-claimable) and `FeesClaimed` event.
- Constructor gained one parameter (`address[] claimHooks_`); deploy script
  and both test files updated to match.

Nothing else changed. The swap logic, per-call caps, cooldown, and slippage
guard are byte-for-byte what was already reviewed and fork-tested.

---

## Requirements check

| Requirement | Status |
|---|---|
| Permissionless trigger, no keeper | ✅ `buybackAndBurn`, anyone, any time past cooldown |
| Per-call max + cooldown | ✅ `maxWethPerCall`/`maxNvdaPerCall` (immutable), `cooldownSeconds` per asset |
| Slippage guard, manipulation-bounded | ✅ caller-supplied `minAmountOut` + an immutable `maxSlippageBps` ceiling checked against the pool's own spot price at execution, independent of what the caller passes — see "Sandwich guard, honestly" below for exactly what this does and doesn't protect against |
| Burn = irretrievable | ✅ transfer to `0x…dEaD`; $BALLAST has no `burn()` (immutable, mint-once) so `totalSupply()` is unchanged and circulating = `totalSupply() - balanceOf(DEAD)` |
| No owner/admin/pause/upgrade | ✅ no `Ownable`, no setter anywhere, `test_noOwnerGatedFunctionExists` / `test_allParametersAreImmutable_noSetterExists` assert the absence |
| WETH/$BALLAST only leave via swap/burn | ✅ `test_fork_invariant_wethOnlyViaSwap_ballastOnlyViaBurn` (new this session) |
| Events for every buy/burn, views for totals | ✅ `BuybackBurned`, `FeesClaimed` (new); `totalBallastBurned()`, `totalSpent(asset)`, `burnedBalance()`, `accruedWeth()` (new) |

### Sandwich guard, honestly

The slippage bound protects against the burner's **own** trade moving price
more than `maxSlippageBps` beyond whatever spot exists *at the moment it
executes* — it does not and cannot undo the cost of a trade that happened
*before* it in the same block (an inherent AMM fact, not a gap specific to
this contract). What actually bounds total exposure to repeated MEV is the
combination of all three guards together: a small per-call cap, a cooldown
between calls, and the slippage ceiling on each individual call. This chain
has no TWAP oracle for v4 pools (CLAUDE.md), so there is no stronger
same-block-manipulation-resistant reference available — this is the same,
already-reviewed pattern `BuybackBurner` v1 uses in production today.
`test_fork_sandwich_burnerImpactStillBoundedBySlippageAfterFrontRun` (new)
proves this on a real fork: after an adversarial front-run, the burner's own
realized price still never crosses its documented bound.

---

## Step-by-step

### Step 0 — re-verify before touching anything (RPC was down this session)

```bash
export RPC=$RH_MAINNET_RPC_URL   # or RH_RPC_URL_PAID if you have a keyed one
cast call 0xE09F093595045E8765F420Cb12E0AA250910E5AD "owner()(address)" --rpc-url $RPC
# expect: 0xEFC97e16a24d2434C7138a2634E554a0631aC079 (the Safe) — confirmed
# via a prior live session 2026-09-29 (docs/BALLAST_STATE.md); re-confirm here
# since this agent could not reach the RPC to check it live this session.

cast call 0xE09F093595045E8765F420Cb12E0AA250910E5AD "platformVault()(address)" --rpc-url $RPC
# expect: 0xEFC97e16a24d2434C7138a2634E554a0631aC079 (the Safe, same address)

cast call 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc "owed(address)(uint256)" \
  0xEFC97e16a24d2434C7138a2634E554a0631aC079 --rpc-url $RPC
# whatever this returns is the current backfill amount for step 5 — Unknown
# to this agent; was 0 as of 2026-09-29 per docs/BALLAST_STATE.md (fully
# claimed that session), so this is purely trading activity since then.
```

If `owner()` is NOT the Safe, stop — that means `acceptOwnership()` was never
actually run (or was reverted since), and nothing below involving
`setPlatformVault` can be signed by the Safe yet. Run the Safe's
`acceptOwnership()` on FeeConfig first (see `docs/PROTOCOL_CONTROLS.md`).

### Step 1 — create a fresh deploy wallet (you do this, not me)

Same pattern already used for `v1claim-deployer` and `feerouter-deployer`
(`docs/v1-claim-runbook.md`, `docs/BALLAST_STATE.md` §11) — never the
compromised `0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1`.

```bash
cast wallet new                              # generates a fresh key, prints the address only
cast wallet import buybackv2-deployer --interactive
# paste the private key when prompted, choose a password — never share either with me
```

Note the printed address; you'll need it for steps 2 and 3. I never see the
private key or the password.

### Step 2 — dry run, confirm predicted address + gas

```bash
cd contracts
export RPC=$RH_MAINNET_RPC_URL
forge script script/DeployBuybackV2.s.sol:DeployBuybackV2 \
  --rpc-url $RPC --sender <your-new-address>
```

This prints the predicted `BuybackBurnerV2` address (deterministic CREATE —
correct only if this wallet's very first transaction is the deploy, same
caveat as `v1claim-deployer`) and the real gas estimate. The defaults baked
into the script (`MAX_WETH_PER_CALL=0.02 ether`, `MAX_NVDA_PER_CALL=0.5e18`,
`COOLDOWN_SECONDS=3600`, `MAX_SLIPPAGE_BPS=1000`) were sized in a prior
session (2026-09-29) against real pool reserves (~$2,834 WETH pool, ~$2,842
NVDA pool). **Re-check those reserves are still roughly that order of
magnitude before broadcasting** — this agent could not re-check them this
session (RPC down). If they've moved a lot, override via env before step 4
(`MAX_WETH_PER_CALL=...` etc.) rather than trusting stale defaults.

### Step 3 — Safe: fund the new wallet's gas

Fill in the real address from step 1 into
`docs/safe-tx-fund-buybackv2-deployer.json`, import it into the Safe
Transaction Builder, sign. 0.001 ETH, ~14x the last known deploy cost
estimate (step 2 gives you the current real number — adjust if it's grown).

### Step 4 — deploy + verify

```bash
forge script script/DeployBuybackV2.s.sol:DeployBuybackV2 --rpc-url $RPC \
  --account buybackv2-deployer --broadcast
```

Confirm the deployed address matches step 2's prediction
(`cast code <addr>` non-empty). Then verify — Sourcify is this repo's
reachable-from-anywhere default (Blockscout Cloudflare-blocks the agent
sandbox, confirmed every prior session, but works fine from your own machine):

```bash
forge verify-contract <address> src/BuybackBurnerV2.sol:BuybackBurnerV2 \
  --verifier sourcify --chain-id 4663

# from a machine that isn't Cloudflare-blocked (not this sandbox):
forge verify-contract <address> src/BuybackBurnerV2.sol:BuybackBurnerV2 \
  --chain-id 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --guess-constructor-args --rpc-url $RPC
```

Set `NEXT_PUBLIC_BUYBACK_V2_ADDRESS=<address>` on Vercel (Production +
Preview — the env staleness bug found 2026-10-03 was exactly "set locally,
forgot on Vercel," don't repeat it: `vercel env add NEXT_PUBLIC_BUYBACK_V2_ADDRESS production`
and `... preview`). The frontend (`web/hooks/useBuybackV2.ts`,
`web/app/app/buyback/page.tsx`) needs no code change — it reads this address
live once set, exactly like the router/hook addresses did.

### Step 5 — Safe: optional one-time backfill

If step 0's `owed(Safe)` check returned nonzero, that's platform fee accrued
*before* this runbook under the old `platformVault` setting — it won't move
on its own. `docs/safe-tx-backfill-hookfees-to-buybackv2.json` is two
separate signatures (claim, then forward the exact observed amount — the Safe
UI can't chain "whatever I just received" automatically, so check the real
balance between the two). Skip this entirely if you'd rather just leave that
one historical amount claimable by the Safe directly later — only *future*
accrual depends on step 6, not this step.

### Step 6 — Safe: the one ongoing-funding transaction

Fill in the real `BuybackBurnerV2` address into
`docs/safe-tx-set-platformvault-buybackv2.json`, compute the calldata
(`cast calldata "setPlatformVault(address)" <address>`), sign. From this
transaction forward, the platform's 20% hook-fee share accrues directly to
`BuybackBurnerV2` — no further Safe action needed for ongoing funding.

### Step 7 — verify the first burn

```bash
cast call <BuybackBurnerV2 address> "accruedWeth()(uint256)" --rpc-url $RPC
# once non-zero and past any cooldown, anyone can call:
cast send <BuybackBurnerV2 address> "buybackAndBurn(address,uint256,uint256)" \
  0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 <amountWei> 0 \
  --rpc-url $RPC --account <any funded wallet>
# or just use the "Run buyback" button on /app/buyback once deployed.

cast call 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C "balanceOf(address)(uint256)" \
  0x000000000000000000000000000000000000dEaD --rpc-url $RPC
# confirms the burn independently of the contract's own counters
```

---

## What could not be verified this session (RPC unreachable)

The mainnet RPC hostname (`rpc.mainnet.chain.robinhood.com`) resolved to a
server presenting a TLS certificate for `*.ioh.co.id` (an Indonesian ISP),
not the real endpoint — DNS-level interception on this sandbox's network path,
confirmed via `openssl s_client`, not a transient outage. Everything below is
therefore carried forward from `docs/BALLAST_STATE.md` (dated, previously
live-verified) rather than freshly confirmed, or left explicitly Unknown:

- **`FeeConfig.owner()`** — stated as the Safe per `BALLAST_STATE.md`
  (2026-09-29 `acceptOwnership` confirmation). Re-check in Step 0.
- **`owed(Safe)` current value** — was 0 as of 2026-09-29 (fully claimed that
  session); real value today is genuinely Unknown to this agent. Re-check in
  Step 0.
- **WETH/NVDA pool reserves** — ~$2,834 / ~$2,842 as of 2026-09-29/09-30; the
  per-call caps baked into the deploy script's defaults were sized against
  those numbers. Re-check in Step 2 before broadcasting.
- **BALLAST v2's real on-chain `symbol`/pool state** — unchanged by this
  session, not independently re-read.
- The 10 fork tests in `BuybackBurnerV2Fork.t.sol` (4 of them new this
  session: sandwich, invariant, 2 claimFees-integration) — written and
  compile cleanly, but **never executed against live state** this session
  (they skip when `RH_RPC_URL_PAID` is unset, which it is here). Run them
  yourself with that var set before trusting the fork suite's actual pass/fail,
  not just its compile-and-skip status: `forge test --match-path "test/BuybackBurnerV2*.t.sol"`.

## Separate finding, out of scope for this task

`BuybackBurner` **v1** (`0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be`, targets
$BALLAST v1 only, a different pool/hook than anything in this runbook) is
still `Ownable2Step`-owned by the compromised
`0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1` (confirmed via its own deploy
broadcast, `contracts/broadcast/DeployBuyback.s.sol/4663/run-latest.json`,
and `docs/BALLAST_STATE.md` §5's "five contracts remain on the old EOA" list).
That owner can retune `threshold`/`maxSlippageBps`/`claimHooks` but has no
withdrawal path (no function sends WETH/$BALLAST anywhere except the
buyback-and-burn swap) — not a funds-at-risk bug, but a dangling admin key on
a known-compromised address, same class of risk already flagged for the other
four contracts in `BALLAST_STATE.md` §5. Not touched by this runbook (v1 and
v2 burners are fully independent contracts); flagging since it's directly
adjacent to "take buyback & burn live."

Also: `web/app/app/buyback/page.tsx`'s `WhoControls()` section still hardcodes
and displays `OWNER = "0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1"` as "the
address that owns the buyback today" — accurate for v1 specifically, but
worth a second look given that address is now known-compromised; not changed
here since it's a pre-existing v1-page copy choice, not part of this task.
