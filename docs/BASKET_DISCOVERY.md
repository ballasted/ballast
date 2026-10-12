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

## 2. Route + price-impact table (all AssetRegistry-listed assets)

_Pending — running against `$RH_RPC_URL_PAID` now. AssetRegistry
(`0x427764d0d19aB765c35A41A5aa4771580307dA81`) lists stock tokens by address;
unlike Ballast's own gen-4 hook pools, stock-token/WETH liquidity is
third-party (Uniswap + Pleiades LPs per `docs/robinhood-chain-research.md`
§2), so routability is NOT assumed — each asset's pool (if any) is being
discovered via `PoolManager` `Initialize` event logs and quoted at
0.01/0.1/1 ETH via `V4Quoter`, impact measured against the same
asset's Chainlink feed. Table filled in below once that sweep completes._
