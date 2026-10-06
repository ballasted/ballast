# $BALLAST v2 buyback & burn — go-live runbook

Everything below is prepared and tested against live mainnet state. Nothing
has been broadcast and no Safe transaction has been signed — this is the
exact ordered sequence for you to run it yourself (or tell me to run the
parts that don't need your signature).

---

## What this does

The platform takes a 1% fee on every swap through every pool the singleton
`BallastHook` serves (`0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc`), split
80% creator / 20% platform (`FeeConfig` gen-4, `0xE09F093595045E8765F420Cb12E0AA250910E5AD`,
confirmed live: `owner()` and `platformVault()` are both the Safe,
`0xEFC97e16a24d2434C7138a2634E554a0631aC079`; the 80/20/0 split has applied
to gen-4's entire history — confirmed via the single `ParamsUpdated` event
ever emitted).

After this runbook: that 20% share accrues directly to a new, immutable,
ownerless contract (`BuybackBurnerV2`). Anyone may call `buybackAndBurn` at
any time (no keeper) for WETH or NVDA — it pulls whatever's accrued, buys
$BALLAST v2 on the open market through the matching real pool, and sends
everything bought to `0x…dEaD`, irretrievably. Any OTHER asset's platform
share (there is no $BALLAST v2 pool to burn it through) is pulled the same
way and forwarded WHOLE to the Safe via the permissionless
`claimOtherFees(asset)` — never held, never spent here.

---

## Funding path: change the recipient

One Safe transaction, `FeeConfig.setPlatformVault(BuybackBurnerV2 address)`.
From then on every swap's platform fee share accrues as `owed`/`owedIn`
against `BuybackBurnerV2` directly — no further Safe action, ever, for WETH
or NVDA funding. (The alternative — the Safe manually claiming and
forwarding, forever, two signatures every time — was considered and
rejected: this task's own requirement is "permissionless trigger, no
keeper," and Path A needs exactly one signature, ever.)

**This is separate from BALLAST v2's own creator fee.** v2's creator (the
Safe, immutable, set at launch) earns its own 80% creator share from v2's own
pools specifically — a different, pre-existing, still-optional routine
(`docs/safe-tx-fund-buybackv2.json`) where the Safe may choose to forward
some of *that* money to the burner too. Nothing in this runbook touches that
path.

---

## What `BuybackBurnerV2.sol` does, in full

**WETH and NVDA** (the two assets with a real $BALLAST v2 pool):
auto-claimed inside `buybackAndBurn` (via `owed`/`claim()` for WETH,
`owedIn`/`claimIn(NVDA)` for NVDA — BallastHook's two parallel fee ledgers,
`src/BallastHook.sol:335-343`), then spent only through the swap, burned.
`accruedWeth()`/`accruedNvda()` views, `maxWethPerCall`/`maxNvdaPerCall`
immutable per-call caps, a per-asset `cooldownSeconds`, and a caller-quote +
`maxSlippageBps`-bounded spot check — unchanged from the original design,
fork-tested against real liquidity.

**Every other asset** (a non-WETH, non-NVDA platform fee share — today that
means a future SGOV-, SPY-, or any other GREEN-quote-asset-quoted gen-4
launch; none has ever happened, confirmed by scanning gen-4's full
`FeeTaken` history): pulled via the permissionless `claimOtherFees(asset)`,
which calls `claimIn(asset)` on every configured hook, then forwards the
contract's **entire** balance of that asset — whatever was just claimed plus
anything sent here any other way — to the immutable `fallbackRecipient`
(the Safe). `claimOtherFees` reverts for `weth`, `nvda`, and `ballast`. New
`OtherFeesForwarded` event, `totalForwarded(asset)` view.

**Why this exists**: the first version of this contract (this session,
earlier) only pulled the WETH ledger. A live fork test proved that any
non-WETH-quoted platform fee would have been **permanently stuck** —
`owedIn` is keyed by `msg.sender`, so only the contract itself could ever
call `claimIn` for it, and it had no function that did. Fixed before
anything was deployed.

**Self-referential fee, confirmed on a live fork, not a bug**: once
`platformVault` is the burner, the burner's *own* buyback swap is itself
subject to the hook's 1% fee, and 20% of that fee credits straight back to
`owedIn[burner][asset]` — *after* that call's pre-swap claim already ran, so
a small residual is left over each time. Not stuck: the next permissionless
call (another buyback, or a standalone `claimFees()`) picks it up. Proven
explicitly in `test_fork_nvdaPlatformFeeIsClaimedAndBurned_afterSetPlatformVault`.

No owner, no admin function, no setter — for any parameter, including
`claimHooks` and `fallbackRecipient` (both set once at construction).

---

## Requirements check

| Requirement | Status |
|---|---|
| Permissionless trigger, no keeper | ✅ `buybackAndBurn` (WETH/NVDA) and `claimOtherFees` (everything else), anyone, any time past cooldown |
| Per-call max + cooldown | ✅ `maxWethPerCall`/`maxNvdaPerCall` (immutable), `cooldownSeconds` per asset — unaffected by `claimOtherFees`, which has no cap (it only ever forwards to the Safe, never spends) |
| Slippage guard, manipulation-bounded | ✅ caller-supplied `minAmountOut` + an immutable `maxSlippageBps` ceiling checked against the pool's own spot price at execution — see "Sandwich guard, honestly" below |
| Burn = irretrievable | ✅ transfer to `0x…dEaD`; $BALLAST has no `burn()` so `totalSupply()` is unchanged and circulating = `totalSupply() - balanceOf(DEAD)` |
| No owner/admin/pause/upgrade | ✅ no `Ownable`, no setter anywhere |
| WETH/NVDA leave only via swap; $BALLAST only via burn; anything else only to the Safe | ✅ fork-tested invariants, including a dedicated proof for the third-asset path |
| Events for every buy/burn/forward, views for totals | ✅ `BuybackBurned`, `FeesClaimed`, `OtherFeesForwarded`; `totalBallastBurned()`, `totalSpent(asset)`, `totalForwarded(asset)`, `burnedBalance()`, `accruedWeth()`, `accruedNvda()` |

### Sandwich guard, honestly

The slippage bound protects against the burner's **own** trade moving price
more than `maxSlippageBps` beyond whatever spot exists *at the moment it
executes* — it does not and cannot undo the cost of a trade that happened
*before* it in the same block. What bounds total exposure to repeated MEV is
the combination of all three guards together: a small per-call cap, a
cooldown between calls, and the slippage ceiling on each call. This chain has
no TWAP oracle for v4 pools, so there is no stronger same-block-manipulation-
resistant reference available — the same pattern `BuybackBurner` v1 already
uses in production. `test_fork_sandwich_burnerImpactStillBoundedBySlippageAfterFrontRun`
proves this on a real fork.

---

## Step-by-step

### Step 0 — live state, confirmed this session

```
FeeConfig.owner()         = 0xEFC97e16a24d2434C7138a2634E554a0631aC079 (the Safe)
FeeConfig.platformVault() = 0xEFC97e16a24d2434C7138a2634E554a0631aC079 (the Safe)
owed(Safe) on the hook    = time-sensitive — re-check before signing, it moves
                             with every WETH-quoted swap on gen-4:
                             cast call 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc \
                               "owed(address)(uint256)" 0xEFC97e16a24d2434C7138a2634E554a0631aC079 \
                               --rpc-url $RH_MAINNET_RPC_URL
```

If `owner()` is NOT the Safe when you check, stop — `setPlatformVault` can't
be signed by the Safe yet. Run the Safe's `acceptOwnership()` on FeeConfig
first (`docs/PROTOCOL_CONTROLS.md`).

### Step 1 — create a fresh deploy wallet (you do this, not me)

**Abandoned attempt, 2026-10-06:** the first keystore,
`0xaBb6c6FBFd72a24C15a051D133c4c445ED725DC8`, had its password lost before
anything was signed. Confirmed live on mainnet this session: nonce **0**,
so nothing was ever broadcast from it — the deploy never happened and the
predicted address it printed (`0xcd664C518620140Bee7C95aa6468c40D75026252`)
was never used. It still holds a stranded 0.002 ETH balance that is
unspendable without the password; not a security issue (no private key
exposure, no deploy occurred), just dead weight. Do not fund it further and
do not reference its predicted address anywhere.

The replacement, `0x3638643E80Ce1D7eeDB33A5603b6B6bf22802C8F`, is confirmed
live this session: nonce 0, balance 0, no code (plain EOA) — clean to use.
`docs/safe-tx-fund-buybackv2-deployer.json` already targets this address.

One command — creates an encrypted keystore directly, never prints the
private key (only the password prompt, hidden, and the resulting address):

```bash
cast wallet new ~/.foundry/keystores buybackv2-deployer
```

Send me only the printed address.

### Step 2 — dry run, confirm predicted address + gas

```bash
cd contracts
export RPC=$RH_MAINNET_RPC_URL
forge script script/DeployBuybackV2.s.sol:DeployBuybackV2 --rpc-url $RPC --sender 0x3638643E80Ce1D7eeDB33A5603b6B6bf22802C8F
```

Prints the predicted `BuybackBurnerV2` address (deterministic CREATE —
correct only if this wallet's very first transaction is the deploy) and the
real gas estimate. Constructor args baked into the script: `claimHooks = [HOOK]`,
`fallbackRecipient = 0xEFC97e16a24d2434C7138a2634E554a0631aC079` (the Safe).
Defaults `MAX_WETH_PER_CALL=0.02 ether`, `MAX_NVDA_PER_CALL=0.5e18`,
`COOLDOWN_SECONDS=3600`, `MAX_SLIPPAGE_BPS=1000` — sized in a prior session
against real pool reserves; re-check those reserves are still roughly that
order of magnitude before broadcasting (override via env if not).

Re-run this session, 2026-10-06, against the new wallet: predicted address
`0xDA9ef87A6146f435d34237a9B3a81689603Fa503` (confirmed via both the dry run
and `cast compute-address --nonce 0`), estimated cost
0.000098554498501401 ETH at 0.040040001 gwei.

### Step 3 — Safe: fund the new wallet's gas

`docs/safe-tx-fund-buybackv2-deployer.json` already has the real address
(`0x3638643E80Ce1D7eeDB33A5603b6B6bf22802C8F`) filled in — import it into the
Safe Transaction Builder, sign.

### Step 4 — deploy + verify

`--account` alone wasn't enough for the prior attempt — it failed during
simulation on "default sender" before anything was sent. Pass `--sender`
explicitly alongside `--account` this time:

```bash
forge script script/DeployBuybackV2.s.sol:DeployBuybackV2 --rpc-url $RPC \
  --account buybackv2-deployer --sender 0x3638643E80Ce1D7eeDB33A5603b6B6bf22802C8F --broadcast
```

Confirm the deployed address matches step 2's prediction (`cast code <addr>`
non-empty), then confirm every immutable matches what was intended:

```bash
cast call <addr> "fallbackRecipient()(address)" --rpc-url $RPC   # expect the Safe
cast call <addr> "claimHooksLength()(uint256)" --rpc-url $RPC    # expect 1
cast call <addr> "claimHooks(uint256)(address)" 0 --rpc-url $RPC # expect the hook
cast call <addr> "maxWethPerCall()(uint256)" --rpc-url $RPC
cast call <addr> "maxNvdaPerCall()(uint256)" --rpc-url $RPC
cast call <addr> "cooldownSeconds()(uint256)" --rpc-url $RPC
cast call <addr> "maxSlippageBps()(uint16)" --rpc-url $RPC
```

Verify on Sourcify (reachable from anywhere) and Blockscout (from your own
machine, not this sandbox):

```bash
forge verify-contract <address> src/BuybackBurnerV2.sol:BuybackBurnerV2 \
  --verifier sourcify --chain-id 4663

forge verify-contract <address> src/BuybackBurnerV2.sol:BuybackBurnerV2 \
  --chain-id 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --guess-constructor-args --rpc-url $RPC
```

Set `NEXT_PUBLIC_BUYBACK_V2_ADDRESS=<address>` on Vercel (**Production AND
Preview** — a prior session's env-staleness bug was exactly "set locally,
forgot on Vercel," don't repeat it). The frontend needs no code change — it
reads this address live once set.

### Step 5 — Safe: optional one-time backfill

If step 0's `owed(Safe)` check returned nonzero, that's platform fee accrued
*before* this runbook under the old `platformVault` setting — it won't move
on its own. `docs/safe-tx-backfill-hookfees-to-buybackv2.json` is two
separate signatures (claim, then forward the exact observed amount). Skip
entirely if you'd rather leave that one historical amount claimable by the
Safe directly later — only *future* accrual depends on step 6.

### Step 6 — Safe: the one ongoing-funding transaction

Fill in the real `BuybackBurnerV2` address into
`docs/safe-tx-set-platformvault-buybackv2.json`, compute the calldata
(`cast calldata "setPlatformVault(address)" <address>`), sign. From this
transaction forward, the platform's 20% hook-fee share accrues directly to
`BuybackBurnerV2` for WETH and NVDA, and (via `claimOtherFees`, see above)
is forwarded to the Safe for anything else — no further Safe action needed.

### Step 7 — verify the first burn

```bash
cast call <addr> "accruedWeth()(uint256)" --rpc-url $RPC
cast call <addr> "accruedNvda()(uint256)" --rpc-url $RPC
# once either is non-zero and past cooldown, anyone can call (or use the
# "Run buyback" button on /app/buyback once NEXT_PUBLIC_BUYBACK_V2_ADDRESS is set):
cast send <addr> "buybackAndBurn(address,uint256,uint256)" \
  0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 <amountWei> 0 \
  --rpc-url $RPC --account <any funded wallet>

cast call 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C "balanceOf(address)(uint256)" \
  0x000000000000000000000000000000000000dEaD --rpc-url $RPC
# confirms the burn independently of the contract's own counters
```

---

## Test status

49 tests for `BuybackBurnerV2` (24 unit + 25 fork), **all executed against
live mainnet state this session**, all passing — not compile-and-skip:
`forge test --match-path "test/BuybackBurnerV2*.t.sol"` with
`RH_RPC_URL_PAID` set to the mainnet RPC. Includes a real `setPlatformVault`
prank as the real Safe, a real NVDA-pool swap generating a real platform
fee, a real claim-and-burn, and a real third-asset (SGOV) forward landing in
the Safe for the exact seeded amount.

## Separate finding, out of scope for this task

`BuybackBurner` **v1** (`0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be`, targets
$BALLAST v1 only, a different pool/hook than anything in this runbook) is
still `Ownable2Step`-owned by the compromised
`0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1`. That owner can retune
`threshold`/`maxSlippageBps`/`claimHooks` but has no withdrawal path — not a
funds-at-risk bug, but a dangling admin key on a known-compromised address.
Not touched by this runbook (v1 and v2 burners are fully independent
contracts).

`web/app/app/buyback/page.tsx`'s `WhoControls()` section now discloses this
plainly (updated this session) and states clearly that it applies to the v1
burner only — $BALLAST v2's burner has no owner at all.
