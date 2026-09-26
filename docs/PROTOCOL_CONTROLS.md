# Protocol controls

What can still be changed after deploy, by whom, and under what delay. Written
2026-09-26 in response to a Serialized audit on $BALLAST (hook
`0x9C15c992E4De3711715C8B7D717EF46e474680CC`) flagging three owner-controlled
functions as contradicting the "nobody can change it" pitch. The audit was
right that these exist — this doc is the honest accounting, plus the plan to
put them behind a public delay instead of pretending they don't exist.

## What has ZERO admin surface — verified from source, all generations

`BallastFactory`, `BallastSeeder`, `BallastHook` have **no `onlyOwner`
function anywhere** — confirmed by grep across every deployed generation's
source. `BallastHook.feeConfig` is immutable, set once at construction,
never reassignable. `BackingLens` has no admin surface either (its
`sequencerUptimeFeed` is immutable). These four contracts cannot be changed
by anyone, ever, ownership or not.

## What DOES have an admin key — the full list, nothing omitted

| Contract | Function | Effect | Current owner |
|---|---|---|---|
| `FeeConfig` | `setParams(feeBps, creatorBps, platformBps, referrerBps)` | Change the swap fee (hard-capped at `MAX_FEE_BPS = 1000`, i.e. 10%) and its 3-way split | `0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1` (hot EOA) |
| `FeeConfig` | `setPlatformVault(address)` | Redirect where the platform's fee share is sent | same EOA |
| `FeeConfig` | `setReferrer(address, bool)` | Add/remove an allowlisted referrer | same EOA |
| `AssetRegistry` | `setAsset(...)` / `removeAsset(...)` | Add or remove which assets are treasury-eligible | same EOA |

Both contracts use OpenZeppelin `Ownable2Step` (a two-step transfer — the new
owner must accept — so a typo'd address can't accidentally take over. It does
**not** add a delay).

**A finding beyond the audit's three items, from checking "all generations"
as asked:** there are actually **two separate `FeeConfig` instances live
today**, not one. The oldest hook generation ($BALLAST/CHRS/RCN's hook,
`0x9C15c992…80CC`) reads from a *different* `FeeConfig` at
`0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304` — not the address the audit
named (`0xc0b895bc…`, which the current and immediately-prior hook
generations share). Both instances are owned by the same EOA, both have
identical fee params (1%, 50/35/15 split) and the same `MAX_FEE_BPS`, but they
have **different `platformVault` addresses** (`0x3b4f9a42…` for the oldest
generation vs `0x36198Dae…` for the current one) — a real, previously
undocumented drift, not a security issue by itself, but worth knowing before
transferring ownership: **both instances need to move to the timelock**, not
just the one the audit named.

## Why not renounce ownership entirely

Renouncing leaves `AssetRegistry` permanently frozen — if a legitimate stock
token's canonical address ever needs to be corrected, or a new asset added,
nobody could ever do it again. It also leaves `FeeConfig` unable to respond
to a real problem (e.g. a referrer address getting compromised). A frozen
contract is not the same thing as a trustworthy one. The middle ground: an
admin key that still exists, but can only act after a public, unskippable
delay — long enough that anyone watching has time to react before a change
takes effect.

## The fix: TimelockController, not renunciation

`contracts/script/DeployTimelock.s.sol` deploys a standard OpenZeppelin
`TimelockController` — 7-day `minDelay`, your Safe multisig as **both**
proposer and executor, admin renounced at deploy (the `admin` constructor
param is `address(0)`, OZ's own recommended pattern — the timelock
self-administers via `address(this)` only, so no key outside the timelock's
own delayed process can ever change who holds proposer/executor). **Not yet
run** — needs your Safe address first.

Verified on a fork before writing this doc: deployed with a placeholder Safe
address, confirmed `hasRole(PROPOSER_ROLE, safe) == true`,
`hasRole(EXECUTOR_ROLE, safe) == true`, `hasRole(DEFAULT_ADMIN_ROLE, deployer)
== false`, `hasRole(DEFAULT_ADMIN_ROLE, timelock) == true` (self-administers),
`getMinDelay() == 604800`.

### Steps for you to run (nothing here has been executed)

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=<the funded deployer key>
export SAFE_ADDRESS=<your Safe multisig address>
# dry run first
forge script script/DeployTimelock.s.sol:DeployTimelock --rpc-url $RH_RPC_URL_PAID
# then broadcast
forge script script/DeployTimelock.s.sol:DeployTimelock --rpc-url $RH_RPC_URL_PAID --broadcast
```

Note the printed `TimelockController deployed: 0x...` address, then transfer
ownership of **all three** owned contracts to it (`Ownable2Step` is a
two-step transfer — `transferOwnership` then the new owner must
`acceptOwnership`; since the new owner is a contract, the *acceptance* itself
has to be proposed and executed through the timelock, i.e. it's a real
timelocked operation, not instant):

```bash
export TIMELOCK=<address printed above>

# Step 1 — current EOA proposes the transfer (instant, from the EOA):
cast send 0xc0b895bc683bf4aca30c7277d42d068e0973a594 "transferOwnership(address)" $TIMELOCK --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $RH_RPC_URL_PAID
cast send 0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304 "transferOwnership(address)" $TIMELOCK --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $RH_RPC_URL_PAID
cast send 0x427764d0d19aB765c35A41A5aa4771580307dA81 "transferOwnership(address)" $TIMELOCK --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $RH_RPC_URL_PAID

# Step 2 — the Safe must now schedule + (after 7 days) execute
# acceptOwnership() on EACH contract, through the timelock. This is a Safe
# transaction targeting the TimelockController's schedule()/execute()
# functions, not a plain call — use the Safe's own timelock UI if it has one,
# or construct the calldata with `cast calldata "acceptOwnership()"` as the
# `data` for a `schedule(target, 0, data, bytes32(0), salt, minDelay)` call.
```

### Read calls to prove it afterward

```bash
cast call 0xc0b895bc683bf4aca30c7277d42d068e0973a594 "owner()(address)" --rpc-url $RH_RPC_URL_PAID
cast call 0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304 "owner()(address)" --rpc-url $RH_RPC_URL_PAID
cast call 0x427764d0d19aB765c35A41A5aa4771580307dA81 "owner()(address)" --rpc-url $RH_RPC_URL_PAID
# all three should return the TimelockController address, not the EOA
```

**Nothing above has been executed.** No `SAFE_ADDRESS` was provided, so no
timelock has been deployed, and no `transferOwnership` call has been sent.

## What the token page will show (built, live)

A "Protocol controls" section, same spirit as the creator-withdrawal banner —
live chain reads, not a static claim:
- Each remaining admin power, listed plainly (the 4 rows in the table above)
- Who holds it right now: the raw owner address, labeled "Timelock (7-day
  delay)" once ownership actually moves, or "Direct EOA — not yet
  timelocked" until it does (an honest interim state, not hidden)
- Any pending timelocked operation on either `FeeConfig` (both instances) or
  `AssetRegistry`, with its scheduled execution time, read live via the
  `TimelockController`'s `isOperationPending`/`getTimestamp`

## Sell-exact-out block — confirmed, not just from source

Simulated directly against $BALLAST's real mainnet pool (no fork needed —
`V4Quoter` calls are pure simulations):

| Call | Result |
|---|---|
| Buy exact-in (spend WETH, get BALLAST) | Succeeds |
| Sell exact-in (spend BALLAST, get WETH) | Succeeds |
| Sell exact-out (spend BALLAST, get an exact WETH amount) | **Reverts** — `SellExactOutNotSupported()`, confirmed by decoding the quoter's wrapped revert bytes down to the exact 4-byte selector `0x245cb6e7` |
| Buy exact-out (spend WETH, get an exact BALLAST amount) | Succeeds |

This is very likely why third-party scanners report Honeypot as "Unknown"
rather than Pass or Fail: a standard scanner check that includes a
sell-exact-out probe hits a real revert on a real, live, sellable token — it
can't call that "Pass" (something reverted) but the plain sell-exact-in path
clearly works, so it can't call it "Fail" (honeypot) either. See
`docs/scanner-outreach.md` for what to send each scanner.

Exact-out selling is intentionally unsupported today — the hook takes its fee
by reading the swap's own specified amount, and for an exact-out swap that
amount is the OUTPUT, not the input, so the fee math would need a genuinely
different code path to avoid either under- or over-collecting on a partial
fill. Adding it is scoped as a Phase 2 item (next hook generation) — see
`docs/GO_LIVE.md`'s design report for the tradeoff (a new hook address means
another `HISTORICAL_HOOKS` entry, the exact class of bug fixed 2026-09-25).
