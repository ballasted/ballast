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

**Headline result: zero of the 16 AssetRegistry-listed assets have a
discoverable WETH pool as of 2026-10-12.** This is the single most important
finding in this document — it means **none** of the spec's suggested presets
(Index = SPY/QQQ, AI chips = NVDA/AMD/PLTR, Cash-like = SGOV) are routable
right now, so per the spec's own instruction ("drop any that aren't
routable") every preset is currently empty. See §2.3 for what this means for
the build and §2.4 for what was tried and what's left to try.

### 2.1 The 16 allowlisted assets and their Chainlink prices (confirmed live)

| Ticker | Asset address | Feed description | Chainlink USD |
|---|---|---|---|
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | Robinhood SGOV-USD | $101.24 |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | RHNVDA / USD | $229.18 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | RHTSLA / USD | $382.65 |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | Robinhood GOOGL / USD | $350.99 |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | Robinhood AAPL / USD | $336.87 |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | RHMSFT / USD | $538.91 |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | Robinhood AMZN / USD | $261.84 |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | Robinhood META / USD | $728.38 |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | RHSPY / USD | $781.39 |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | Robinhood QQQ / USD | $751.35 |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | RHAMD / USD | $602.83 |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` | Robinhood MSTR / USD | $154.73 |
| PLTR | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | Robinhood PLTR / USD | $208.69 |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | Robinhood COIN / USD | $180.05 |
| ORCL | `0xb0992820E760d836549ba69BC7598b4af75dEE03` | Robinhood ORCL / USD | $141.76 |
| CRCL | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | Robinhood CRCL / USD | $84.44 |

ETH/USD reference: $2,530.28 (feed `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`,
8dp). All 16 are confirmed in the registry via `allowedAssets()`;
Impact @0.01/0.1/1 ETH is "—" for every row because no pool was found to quote
against at any size — see §2.3.

### 2.3 What this means for the build

- `BasketZap` itself is NOT hardcoded to any route — it takes the full
  `PoolKey` (fee/tickSpacing/hooks) per leg as a call parameter, same
  convention `BallastRouterV2` already uses for its `hook` param (see
  `docs/DECISIONS.md`). So the contract works the moment a real route exists,
  with no redeploy.
- The frontend's preset/picker config (`web/lib/basketRoutes.ts`) is a
  **curated, human-sourced table**, not a live on-chain discovery mechanism —
  consistent with how `AssetRegistry` itself is curated, never auto-populated
  (CLAUDE.md's anti-impostor stance: trust comes from a verified canonical
  source, never a spoofable live signal). It currently ships **empty** (every
  asset marked not-yet-routable), so the UI honestly shows "no routable
  assets yet" for every preset rather than pretending something works. Adding
  a real route later is a one-line config change, not a contract change.
- Fork tests (`contracts/test/BasketZapFork.t.sol`) run everything that CAN
  be proven against real mainnet state without a real pool (deploying against
  the real factory/registry/WETH/router/permit2, resolving a real launch's
  creator, the Chainlink freshness gate against a real live feed) and
  `vm.skip(true)` the end-to-end swap assertions with an explicit reason —
  per the hard rule "skipped ≠ passed."

### 2.4 What was tried (so a later session doesn't repeat it) and what's left

Tried, in order:
1. `PoolManager` `Initialize` event log sweep (topics = `id`, `currency0`,
   `currency1`, confirmed indexed by decoding a known real Ballast pool's
   log correctly first). **Not viable on this RPC tier**: Alchemy enforces a
   hard ~5,000-block range cap on `eth_getLogs` regardless of topic filters
   (confirmed empirically). Chain height is ~86.7M blocks, so an exhaustive
   sweep needs ~17,340 sequential requests per topic combination — infeasible
   this session.
2. Direct `StateView.getSlot0(poolId)` probes (poolId computed as
   `keccak256(abi.encode(PoolKey))`, method validated against the same known
   real Ballast pool before trusting it) for all 16 assets against WETH,
   `hooks = address(0)`, across both the four standard Uniswap fee/tickSpacing
   tiers (100/1, 500/10, 3000/60, 10000/200) AND the fee/tickSpacing Uniswap's
   own blog describes for its Robinhood Chain stock-token AMM specifically
   (2500/25 "current path" and 2500/60 "original path" — [Uniswap is Live on
   Robinhood Chain](https://blog.uniswap.org/robinhood-chain-is-live)). **Zero
   hits** across all combinations for all 16 assets.
3. `V4Quoter.quoteExactInputSingle` on SPY/WETH at the 0.3% tier — reverted
   cleanly with no data, consistent with "pool not initialized."
4. Blockscout's REST API — returned a Cloudflare JS challenge to a plain
   fetch, not a usable response.
5. Web search for a documented Pleiades/Uniswap stock-token-AMM hook address
   or a v4 subgraph — confirmed "Robinhood has no v4 subgraph" and that
   discovery is expected to be log-based (same method as #1, same RPC-tier
   wall), and did not surface a specific non-zero hook address for the
   dedicated stock-token AMM the blog post references.

**Not ruled out:** a pool using a non-zero, undocumented hook address (the
blog post confirms "Uniswap deploying a dedicated AMM" for stock tokens but
doesn't publish its hook contract), or liquidity against USDG rather than
WETH (the chain's other RFQ-quote asset, e.g. "NVDA ↔ USDG") — using a USDG
route would require a WETH→USDG→stock multi-hop, which BALLAST deliberately
never ships (`contracts/src/interfaces/IRobinhoodV4Router.sol:20-25`), so
even if found it wouldn't satisfy this spec's "swapped from WETH" requirement
directly. **Next step for a human:** ask Robinhood/Uniswap/Pleiades directly
for the canonical stock-token AMM hook address, or get access to a less
RPC-range-restricted provider / an indexer that already covers this chain's
v4 pools.
