# Stock Basket — discovery

Autonomous build, `feat/stock-basket`. See `docs/DECISIONS.md` for the Option 1
vs Option 2 call and the `onlyCreator` finding that drives it.

## 1. The treasury deposit path

**Contract:** `ProjectTreasury` (`contracts/src/ProjectTreasury.sol`), one
instance per launch, deployed by `BallastFactory.launch()`
(`contracts/src/BallastFactory.sol:370`): `new ProjectTreasury(address(t),
msg.sender, noticePeriod, registry)`. `creator` is `immutable`, fixed forever
to whoever called `launch()`.

**Function:** `deposit(address asset, uint256 amount) external onlyCreator
nonReentrant`.

- **Who may call it:** only `creator` — `onlyCreator` checks `msg.sender ==
  creator` directly. No delegation, no operator, no meta-tx support. **No
  contract can ever call this on the creator's behalf** — see
  `docs/DECISIONS.md` §1. This is the single fact that shapes the whole
  feature.
- **Validation (`_validateAsset`):** `asset != projectToken` (self-backing
  blocked), `amount > 0`, `registry.isAllowed(asset)`, `amount >=
  registry.minDeposit(asset)`.
- **Effect:** pulls `amount` of `asset` from `msg.sender` via
  `safeTransferFrom`, credits `deposited[creator][asset] += amount` and
  `creatorWithdrawable[asset] += amount`. This is the **withdrawable** bucket
  — later withdrawal is gated by the two-phase `announceWithdrawal` /
  `executeWithdrawal` flow with the treasury's own immutable `noticePeriod`
  (7/30/90 days, set at launch, never changeable). There is no way for a
  creator-sourced basket deposit to land in the **locked** bucket
  (`lockedBalance`, permanent) — that path (`proposeDeposit` /
  `acceptDeposit`) is for third-party deposits and requires a separate
  depositor + a 7-day accept window, which doesn't fit "creator pays once."
  So a basket leg is always withdrawable-with-notice, never permanently
  locked, regardless of which option builds it.
- **Notice/lock settings:** fixed per-treasury at launch, read live
  (`noticePeriod()` is a public immutable getter) — never hardcoded by
  anything that touches a treasury.

**How BackingLens reads it:** `BackingLens.backingOf(treasury)`
(`contracts/src/BackingLens.sol:91`) calls `treasury.assets()` to enumerate,
then for each reads `treasury.lockedBalance(asset)` and
`treasury.creatorWithdrawable(asset)` — **not** a raw `IERC20.balanceOf`. A
token sent directly to the treasury's address without going through
`deposit()`/`acceptDeposit()` is invisible to `BackingLens` and stuck
(untracked, unwithdrawable). This rules out any "just transfer the swap
output to the treasury address" shortcut.

**Factory lookup (for `BasketZap`'s creator check):** `BallastFactory`
(`0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67`, confirmed live on-chain,
`launchCount()` = 3) exposes `launchIdOf[token] -> id+1` and a public
`launches(id)` array returning `(token, treasury, creator)` (the dynamic
`quoteAssets` array member is omitted from the auto-generated tuple getter —
confirmed by reading `contracts/src/BallastFactory.sol:101-118` and
cross-checking live: `launches(0..2)` each return exactly the 3-address
tuple). `BasketZap` resolves `(treasury, creator)` from the factory by
`token`, rather than trusting a caller-supplied treasury address directly —
this also guarantees the target really is a genuine Ballast launch, not an
arbitrary contract that happens to expose a `creator()` getter.

Confirmed live launches on the current factory (chain reads, 2026-10-12):

| id | token | treasury | creator | graduated |
|---|---|---|---|---|
| 0 | `0x3Fec2b548755d53fD8DB97CAc0C14DFA99F0e335` | `0x3a1F64760824Fef3E84C231175b44C442aE3dA6a` | `0xEFC97e16a24d2434C7138a2634E554a0631aC079` (the Safe) | true |
| 1 | `0xDc605041F02e41CbD8FDC347023e93C4c3fA243C` ($BALLAST v2) | `0x3b916C765A218B6BcDD376411acD3AA3Efd43737` | `0xEFC97e16a24d2434C7138a2634E554a0631aC079` (the Safe) | true |
| 2 | `0x10842066A3334d76CBBc206D26C670db9768A4BF` | `0xbdf12714eC40ec3d1D29684AE14100ab3f355B4a` | `0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85` | true |

Launch 2 (a non-Safe creator) is the fork-test target for "a basket on an
existing launch" — fork tests impersonate the creator via `vm.prank`, no real
key ever needed for a read/simulate-only fork test.


## 2. Route + price-impact table (all 16 AssetRegistry-listed assets)

**This section was rewritten this session (see `docs/DECISIONS.md` §6). The
previous version concluded "zero routable WETH pools exist" — that was wrong,
because it only looked for direct WETH/<stock> v4 pools.** The real liquidity
is (a) Fables v4 pools quoted in **USDG** (ETH→USDG→stock, same PoolManager we
use, Fables hooks) and (b) **Ramses v3** pools (direct WETH/<stock> or
WETH→USDG→stock). `BallastRouterV2` already discovered and productionised both
route sets; `BasketZap` now reuses its exact `fablesHops`/`ramsesRoutes` tables
(`contracts/script/DeployBasketZap.s.sol`, index-for-index identical to
`DeployBallastRouterV2.s.sol`).

### 2.1 Method

Read-only on-chain probe `contracts/script/probe/QuoteBasketRoutes.s.sol` (run
WITHOUT `--broadcast`), against live mainnet via the paid RPC, 2026-10-13:

- **Ramses** quoted through the live Ramses QuoterV2
  (`0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6`), chaining
  `quoteExactInputSingle` per hop (WETH→USDG then USDG→stock for the 2-hop
  assets).
- **Fables** attempted through the live V4Quoter
  (`0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`) `quoteExactInput` multi-hop.
- **Chainlink fair value** = `ethIn × ethUsd / assetUsd` (both feed prices read
  live; decimals cancel). ETH/USD = **$2,533.01** at probe time.
- Sizes: 0.01 / 0.1 / 1 ETH. **Routable = impact ≤ 3% (≤300 bps) at 0.1 ETH**
  vs Chainlink, per the brief.

> **Fables quoting caveat (honest limitation):** every Fables `quoteExactInput`
> in this probe returned 0 — uniformly, for all 16 assets at all sizes,
> including the shared deep ETH/USDG entry hop. This is almost certainly the
> native-ETH (`currencyIn = address(0)`) multi-hop path reverting inside the
> fork's V4Quoter rather than genuine zero liquidity (the identical Fables
> routes execute successfully in `BallastRouterV2`'s own fork suite, and
> BasketZap's `test_fork_fallsBackToRamses…` proves the contract's venue
> machinery works). The live frontend (`web/hooks/useRouterV2Swap.ts`,
> `quoteFablesLeg1`) already attempts Fables per-call and silently falls back to
> Ramses when the quote fails, so the table below — built on the venue that
> **demonstrably quotes and executes, Ramses** — is the conservative floor.
> Fables can only ADD routable assets at small tickets (the deploy-script note
> flags META / MSTR / SPY-QQQ as Fables-deep only for small size); it never
> subtracts. A human with a working off-chain Fables quote path should re-run
> the probe to widen the routable set.

### 2.2 Route + impact table (Ramses venue, measured)

Impact in basis points (100 bps = 1%); "dead" = quote returned 0 or ~100% loss.

| Ticker | Chainlink USD | Ramses path | 0.01 ETH | 0.1 ETH | 1 ETH | Routable (≤3% @0.1)? |
|---|---|---|---|---|---|---|
| SGOV | $101.25 | WETH→USDG→SGOV | 0.03% | **0.04%** | 0.10% | ✅ |
| AAPL | $342.30 | WETH→USDG→AAPL | 0.15% | **0.18%** | 0.49% | ✅ |
| GOOGL | $352.94 | WETH→USDG→GOOGL | 0.14% | **0.15%** | 0.25% | ✅ |
| NVDA | $225.32 | WETH→NVDA (direct) | 0.11% | **0.22%** | 1.27% | ✅ |
| SPY | $778.58 | WETH→SPY (direct) | 0.22% | **0.24%** | 0.46% | ✅ |
| PLTR | $207.80 | WETH→USDG→PLTR | 0.46% | **0.56%** | 1.57% | ✅ |
| CRCL | $84.44 | WETH→USDG→CRCL | 0.57% | **0.99%** | 2.38% | ✅ |
| QQQ | $743.49 | WETH→QQQ (direct) | 1.54% | 56.70% | 95.67% | ❌ (small-ticket only) |
| MSTR | $156.14 | WETH→USDG→MSTR | 0.12% | 39.13% | 93.86% | ❌ (small-ticket only) |
| TSLA | $374.59 | WETH→USDG→TSLA | 2.33% | 83.56% | 98.35% | ❌ (small-ticket only) |
| COIN | $182.97 | WETH→USDG→COIN | 4.35% | 82.48% | 98.24% | ❌ |
| AMZN | $258.04 | WETH→USDG→AMZN | 50.20% | 90.85% | 99.00% | ❌ |
| META | $735.06 | WETH→META (direct) | dead | dead | dead | ❌ (pool floored) |
| MSFT | $542.01 | WETH→USDG→MSFT | ~99% | ~99% | ~99% | ❌ (pool dead) |
| AMD | $586.40 | WETH→USDG→AMD | ~99% | ~99% | ~99% | ❌ (pool dead) |
| ORCL | $137.37 | WETH→USDG→ORCL | ~99% | ~99% | ~99% | ❌ (pool dead) |

**Routable on Ramses alone (≤3% @0.1 ETH): SGOV, AAPL, GOOGL, NVDA, SPY, PLTR,
CRCL — 7 of 16.** All 7 also stay ≤3% at the full 1 ETH size (max ~2.4% for
CRCL). The direct-WETH pools (NVDA, SPY) and the USDG-bridged majors
(SGOV/AAPL/GOOGL) are the deepest; CRCL and PLTR are routable but thinner.

**Small-ticket-only (would need Fables for real size):** QQQ, MSTR, TSLA clear
≤3% at 0.01 ETH but blow past 3% by 0.1 ETH on Ramses — exactly the assets the
deploy note says are Fables-deep for small tickets only. COIN/AMZN are already
bad at 0.01 ETH. META/MSFT/AMD/ORCL are dead on Ramses at every size (MSFT/AMD/
ORCL additionally have NO Fables route — `fablesHopIdx` empty — so they are
genuinely unroutable until someone adds liquidity).

### 2.3 What this means for the build

- **Chosen execution venue/router: `BasketZap` inheriting v4-periphery's
  `V4Router` + direct Ramses v3 callback — NOT the external UniversalRouter.**
  Rationale and the full rewrite are in `docs/DECISIONS.md` §6. The
  UniversalRouter cannot reach Ramses pools at all and cannot safely execute the
  Fables multi-hop; BasketZap now mirrors `BallastRouterV2`'s proven mechanism
  exactly (per-leg venue preference + in-tx fallback).
- **The frontend route table (`web/lib/basketRoutes.ts`) should ship with the 7
  Ramses-routable assets marked routable**, with the per-asset Fables/Ramses hop
  indices sourced from `web/lib/routerV2.ts` (already the single source of truth
  for those tables). The remaining 9 stay non-routable until Fables quoting is
  verified or liquidity deepens — honest "not routable yet" in the picker, same
  philosophy as before.
- **Validated end-to-end:** `contracts/test/BasketZapFork.t.sol` — 11/11 fork
  tests pass against real mainnet state, executing REAL Ramses swaps
  (swap → approve → deposit → real `BackingLens` readback) on both a fresh and
  an existing launch, plus per-leg venue fallback and the all-venues-failed
  revert. No `TestPoolSeeder` shim any more — the routes are real. 17 unit tests
  also pass (28 total).

### 2.4 Reproduce

```bash
cd contracts
set -a; source ../.env; set +a
forge script script/probe/QuoteBasketRoutes.s.sol:QuoteBasketRoutes --rpc-url "$RH_RPC_URL_PAID"
```

Read-only (no `--broadcast`); prints the full per-asset / per-size table the
numbers above were taken from.

See `docs/BASKET_DEPLOY.md` for the deploy/verify runbook.
