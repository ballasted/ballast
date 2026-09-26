# Phase 2 design report — items 4, 5, 6 (the Ballast combination package)

Status: **design only, no contract code written**. Everything below is either
a proposal awaiting approval (marked **PROPOSE→WAIT**) or a decision the
user already made that this section specifies the exact mechanism for
(marked **DECIDED**). Every factual claim about chain state, addresses, or
aggregator support is sourced inline; anything unverified is flagged as such
rather than assumed.

---

## 0. Redeploy scope — CORRECTED after checking live mainnet state (Phase 3)

**This section was wrong in its original form and is corrected here rather
than silently edited** — the mistake is worth seeing, not hiding.

While implementing, I read the *currently live* factory directly
(`NEXT_PUBLIC_FACTORY_ADDRESS = 0x069974136c78Cf0F2162463B95321E59F56523D8`,
confirmed via `cast call`): `isGreenQuoteAsset(...)` and `ethUsdStaleWindow()`
both revert with no data — functions that don't exist on the deployed
bytecode. Cross-checked against `git log`: the multi-quote-asset generation
(`605eb27` "Multiple stock pairs," `7b1968b` "Seeder: mirror one-sided-liquidity,"
`dccbc8e` "Hook: per-pool quote-asset concept," up through `252410b` "Set
MAX_QUOTE_ASSETS to 2, permanent, **before the factory is ever deployed**")
has never been deployed to mainnet at all. `DeployHook.s.sol` and
`DeployMainnet.s.sol` haven't been touched since before those commits. The
live factory and its hook (`NEXT_PUBLIC_V4_HOOK_ADDRESS =
0x9C15c992E4De3711715C8B7D717EF46e474680CC`) are both the **older,
single-quote-asset generation**.

**What this changes:** my original conclusion ("only Factory needs
redeploying, Seeder/Hook stay as-is") is true only relative to *the
multi-quote-asset source code as already written* — it is not true relative
to *what's actually live*. Seeder and Hook both need their **first-ever**
deployment regardless of items 5/6, because the multi-quote-asset generation
they belong to was never shipped. Items 5/6 don't add a second redeploy on
top of that — they land inside the SAME first deployment — but they don't
avoid one either, because there was never a "leave it alone" option: this
hook generation was always going to be new relative to what's live, the
moment the multi-quote-asset work ships at all.

**§7's decision still stands, just narrower than I originally scoped it:**
"leave the hook alone this round" now correctly means *deploy the
already-written multi-quote-asset hook exactly as it is in the repo, don't
additionally fold the exact-out-sell fix into it* — not "no new hook
deploys." A `HISTORICAL_HOOKS` entry for the current live hook
(`0x9C15c992...`) is required regardless of anything in this report, simply
because the pending multi-quote-asset rollout was always a new hook
generation. This is pre-existing, already-latent risk from an earlier
session's design, not new risk items 4/5/6 created.

One piece of good news from this correction: since the multi-quote-asset
factory was never live, there are **no existing multi-quote-asset launches**
whose pricing this changes — every real launch on the current live factory
(BALLAST, CHRS, RCN, HARUNA, BCAT, etc.) stays on that untouched contract,
unaffected. "Migration" here means completing a pending first deployment
with items 5/6 folded in, not migrating live backing-derived-price pools to
a fixed-price model.

### Redeploy scope, corrected

Before the item-by-item detail: I read `BallastFactory.sol`, `BallastSeeder.sol`,
`BallastHook.sol`, and `OrderingLib.sol` in full to answer requirement (a)
precisely rather than guess.

| Contract | Redeploy needed? | Why |
|---|---|---|
| `BallastFactory` | **Yes — first-ever deploy of this generation** | Item 5 changes `_p0Tick`'s logic; item 6 widens `greenQuoteAssets_` to 16. Lands directly in the multi-quote-asset factory's first deployment. |
| `BallastSeeder` | **Yes — first-ever deploy**, but **zero code changes** for items 5/6 | Already written (`7b1968b`), never deployed. `seed(token, quoteAsset, openTick, amount)` takes `openTick` as a plain parameter regardless of how it was computed — nothing about it changes for items 5/6. |
| `BallastHook` | **Yes — first-ever deploy**, but **zero code changes** for items 5/6 | Already written (`dccbc8e`), never deployed. `_resolvePool` resolves (token, quoteAsset) generically via `creator()` — no dependency on `isGreenQuoteAsset` or quote-asset count. The exact-out-sell fix is deliberately NOT folded in (§7's decision) — ship this hook exactly as already written. |
| `FeeConfig`, `AssetRegistry`, `BackingLens`, `ProjectTreasury`, `BallastToken` | **No** | Untouched, and — for FeeConfig/AssetRegistry — already live; reused by address, not redeployed. |
| New: `BallastRouter` | **New deploy** (item 4) — no existing contract to replace. |

Reused by address (no redeploy): `AssetRegistry`
(`0x427764d0d19aB765c35A41A5aa4771580307dA81`), `FeeConfig`
(constructor param to the new hook — same instance the current live hook
already shares). New: `BallastHook` (CREATE2-mined, same pattern as
`DeployHook.s.sol`), `BallastSeeder`, `BallastFactory`, `BallastRouter`.

The existing migration pattern (`NEXT_PUBLIC_FACTORY_ADDRESS` → new address,
old one appended to `NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES`; new hook added to
`HISTORICAL_HOOKS` in `web/lib/contracts.ts`, confirmed by reading that file)
already handles exactly this shape of change — old, single-quote-asset
launches keep resolving against their own already-live hook unchanged.

---

## 1. Item 5 — exactly 1 ETH fully-diluted, every configuration (DECIDED — mechanism below)

### Current mechanism (`BallastFactory._p0Tick`, read in full)

Today, `_p0Tick(token, treasury, quoteAsset)` loops every asset the treasury
holds, sums USD value via each asset's own Chainlink feed, and feeds that sum
(`backingUsd1e18`) into `BackingMath.p0Tick` as the numerator of "backing per
token." If the treasury holds nothing, it falls back to a hardcoded constant,
`UNBACKED_TICK` (≈1e-9 WETH/token for the 1B supply — i.e. **already exactly
the 1-ETH-FDV price**, just not derived that way or applied to non-WETH
quotes).

### The change

Replace the treasury-derived `backingUsd1e18` with a **fixed target: the USD
value of exactly 1 ETH**, and split by quote asset:

- **WETH-quoted pool:** the ratio (1 ETH's USD value) ÷ (ETH/USD price) is
  identically 1, for any ETH/USD price — the feed cancels out algebraically.
  So this case needs **no feed read at all**: it is `UNBACKED_TICK`,
  unconditionally, exactly like today's unbacked path, just now used for
  *every* WETH-quoted pool regardless of backing. (Suggest renaming
  `UNBACKED_TICK` → `WETH_QUOTE_TICK` for clarity, since "unbacked" is no
  longer the condition that selects it — cosmetic, not required.)

- **Stock-quoted pool:** `price_in_stock = (1 ETH × ETH/USD) / (stock/USD) /
  supply`. Concretely:
  1. Read `ethUsdFeed` via the existing `_quotePrice(weth)` helper — this
     already reverts via `FeedStaleAtLaunch` if the ETH/USD feed is past
     `ethUsdStaleWindow`. Call the result `oneEthUsd1e18` (this is literally
     "USD per 1 ETH," which **is** "USD value of 1 ETH" — no separate
     multiplication needed).
  2. Read the quote asset's own feed via the existing `_quotePrice(quoteAsset)`
     — already reverts via `FeedStaleAtLaunch` if past that asset's
     `AssetRegistry.staleAfter`.
  3. Call `BackingMath.p0Tick(oneEthUsd1e18, TOTAL_SUPPLY, quotePrice1e18,
     quoteDecimals, TICK_SPACING, tokenIsCurrency0)` — **the exact same
     library function, untouched**. Only the caller's inputs change.

New `_p0Tick` signature: `_p0Tick(token, quoteAsset)` — **`treasury` is
removed from the signature entirely**, which is the literal enforcement of
"the treasury deposit must never influence opening price" (a >1 ETH deposit
now has no code path into this function at all, not just a value that
happens to cancel out).

`graduate()` still reads the treasury once per call, but **only** to compute
an informational `backingUsd1e18` for the `Graduated` event (the UI's
"backing per token" display is a separate, still-real number from "opening
price" — decoupling those two is the entire point of item 5). That read has
zero effect on `openTick` or seeded `amount`.

### Tick tolerance

`BackingMath.p0Tick` floor/ceil-aligns to `TICK_SPACING = 60` in the
direction that keeps the opening price **at or below** the true 1-ETH target,
never above (existing, unchanged rounding proof in the library's comments).
Worst case, the true continuous ratio sits just below the next tick boundary,
so the realized opening price can be up to one tick (`~0.6%` at
`tickSpacing=60`, since `1.0001^60 ≈ 1.006`) **below** exactly 1 ETH FDV,
never above it and never off by more than that one tick. State this
tolerance explicitly in `docs/COMBINATION.md` (§8 below) rather than implying
exact-to-the-wei parity.

### Staleness behavior at graduation

- WETH-quoted: no feed dependency, cannot revert on staleness (there's
  nothing to be stale).
- Stock-quoted: reverts (`FeedStaleAtLaunch`) if either the ETH/USD feed or
  the stock's own feed is past its outer staleness bound at the moment
  `graduate()` is called. This is a **narrow, real bound** (equities have a
  24/5 feed per `docs/robinhood-chain-research.md` — the gap is
  weekends/holidays, not "half the time"), and matches CLAUDE.md rule 10:
  never brick the whole product, but a graduation *action* (not a *read*)
  reverting on a genuinely dead feed is the correct behavior — better than
  permanently minting a wrong price into an immutable pool.

### Two pools, one launch

`graduate()` already computes `_p0Tick` **per quote asset**, independently,
inside its existing loop — a launch with `[WETH, NVDA]` gets a WETH pool at
the WETH-derived tick and an NVDA pool at the NVDA-derived tick, **both**
representing the same 1-ETH total FDV (each pool's tick reflects 1 ETH ÷
supply in that pool's own quote units — not 1 ETH each, not 2 ETH combined).
No change needed here: the existing per-quote-asset loop already has the
right shape; only what each iteration computes changes.

---

## 2. Item 6 — quote assets: 3 GREEN → all 16 (DECIDED — mechanism below)

Confirmed by reading the constructor: `isGreenQuoteAsset` is populated from
`greenQuoteAssets_` at deploy, a **constructor argument, not a hardcoded
constant**. Expanding from `{SGOV, NVDA, SPY}` to all 16 registry assets is
**purely a different array passed to the same, unmodified constructor logic**
— zero Solidity change beyond what item 5 already touches in the same file.

Confirmed on-chain (direct RPC calls against `NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS
= 0x427764d0d19aB765c35A41A5aa4771580307dA81`, `allowedAssets()` then
`symbol()` on each):

| Ticker | Address | GREEN today | Depth basis |
|---|---|---|---|
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | ✅ | `exit-liquidity-table.md` |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | ✅ | `exit-liquidity-table.md` |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | ✅ | `exit-liquidity-table.md` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | AMBER | `exit-liquidity-table.md` |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | AMBER (⚠ documented impostor pool at a different address — see below) | `exit-liquidity-table.md` |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | AMBER | `exit-liquidity-table.md` |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | AMBER | `exit-liquidity-table.md` |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | RED (single-route risk) | `exit-liquidity-table.md` |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | AMBER | `exit-liquidity-table.md` |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | AMBER | `exit-liquidity-table.md` |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | 🔴 RED | §3 batch-2 table |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` | 🟡 AMBER | §3 batch-2 table |
| PLTR | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | 🟡 AMBER | §3 batch-2 table |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | 🟡 AMBER | §3 batch-2 table |
| ORCL | `0xb0992820E760d836549ba69BC7598b4af75dEE03` | 🔴 RED | §3 batch-2 table |
| CRCL | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | 🟢 GREEN | §3 batch-2 table |
| cbBTC (crypto quote, not a stock token) | `0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4` | 🟡 AMBER | §3 batch-2 table |

**PROPOSE→WAIT:** expand the factory's constructor argument to **all 16**
stock-token addresses above regardless of GREEN/AMBER/RED — the constant is
now called `isGreenQuoteAsset` but item 6's own instruction is "allow all 16
in the factory (immutable, and Ramses liquidity can deepen post-deploy)."
The AMBER/RED classification stops gating *factory-level* selectability and
becomes a **frontend-only** signal: "reachable with any token" (a verified
`BallastRouter` route exists) vs. "holders only" (still selectable at
`launch()`, with a plain warning, per item 6's own text). With real depth
numbers now in hand (§3), the concrete split is:

- **GREEN** (deep both directly and via a bridge asset): SGOV, NVDA, SPY, **CRCL**.
- **AMBER** (usable, real but bounded slippage, at least one real route):
  TSLA, GOOGL (⚠ impostor-pool risk, see below), AAPL, MSFT, META, QQQ,
  **MSTR, PLTR, COIN, cbBTC**.
- **RED** (single-route or effectively no exit): AMZN, **AMD, ORCL** — AMD
  and ORCL both have no real direct-WETH pool at all (same structural gap as
  AMZN), and ORCL additionally fails the impact threshold outright even on
  its one indexed route (6.9% estimated impact at $5,000) — the thinnest of
  all 17 assets checked across both research passes.

cbBTC is a **crypto** quote-asset candidate (item 6's list is "WETH + the 16
stock tokens," so cbBTC isn't literally in scope for the *stock*-quote-asset
expansion) but is included here since item 4's "PAY WITH" side and the
frontend's CRYPTO section both need its classification too, and it was
sourced this round for the same reason (§3).

**Ticker-impersonation reminder, carried forward:** `exit-liquidity-table.md`
documents a real fabricated GOOGL pool at a *different* contract address
reporting a fake $6.24B reserve. Every quote-asset resolution in
`BallastRouter`, the pairing picker, and any GeckoTerminal-backed depth
lookup must key off the addresses in the table above (sourced from
`AssetRegistry.allowedAssets()` on-chain), never off a ticker string or a
"deepest pool for symbol X" search.

---

## 3. Item 4a — aggregator + venue research (primary sources)

### Aggregator support for chain 4663

Researched via each vendor's own docs (fork task, full findings below —
**no router/settlement address confirmed for any of them yet**, which
matters a great deal for §4b):

| Aggregator | Supports 4663? | Source | Fixed router address published? |
|---|---|---|---|
| **0x Protocol** | ✅ Confirmed | [0x.org/post/robinhood-chain](https://0x.org/post/robinhood-chain) — Swap API + RFQ liquidity live on Robinhood Chain; Tokka Labs is the primary RFQ market maker, USDG as base pair. Matches `docs/robinhood-chain-research.md`'s own line 54 ("0x RFQ for NVDA ↔ USDG"). | **No** — not found on the pages fetched. 0x's architecture typically returns per-quote calldata targeting an "Allowance Holder" contract rather than one static address — needs direct confirmation before it can satisfy a "constructor-fixed target" router design (see §4b risk). |
| **1inch** | ✅ Confirmed | [help.1inch.com/en/articles/15618946-robinhood-chain](https://help.1inch.com/en/articles/15618946-robinhood-chain), [business.1inch.com/chains/robinhood](https://business.1inch.com/chains/robinhood) — "point your existing integration at chain ID 4663," 11 Business APIs live. | **No** address found on fetched pages. |
| **KyberSwap** | ✅ Confirmed | [blog.kyberswap.com/best-dex-aggregator-api-for-swapping-on-robinhood-chain](https://blog.kyberswap.com/best-dex-aggregator-api-for-swapping-on-robinhood-chain/) — Aggregator, Limit Order, KyberZap, Cross-chain Swap all live at chain ID 4663. | **No** address found. |
| **LI.FI** | ✅ Confirmed | [li.fi/knowledge-hub/li.fi-is-live-on-robinhood-chain-from-day-one](https://li.fi/knowledge-hub/li.fi-is-live-on-robinhood-chain-from-day-one) — live from day one, powers Robinhood Wallet's own swap UI. | **No** address found. |
| **Uniswap Trading API** | ✅ Confirmed (chain ID) | [blog.uniswap.org/robinhood-chain-is-live](https://blog.uniswap.org/robinhood-chain-is-live). A Uniswap docs-repo PR (#1161) title references "update Robinhood Chain Universal Router address" — i.e. Uniswap's own docs *do* publish a canonical address for this chain, but the exact string wasn't retrievable through the fetch tooling available tonight (`developers.uniswap.org` blocked the fetch). **This is very likely the same `0x8876789976dEcBfCbBbe364623C63652db8C0904` already independently verified on Blockscout + proven by real execution earlier this session** (see `docs/robinhood-chain-research.md` §4) — but call that a strong inference, not a re-confirmed fact, until someone loads that page directly. |
| **Odos** | Not found | No integration announcement or chain listing found anywhere; not named in KyberSwap's own competitor comparison. **Do not assume support.** |
| **OpenOcean** | Unverified | One indirect, third-party (non-OpenOcean) mention of "Robinhood's solver adapters cover Kyber, Flytrade/Magpie, OpenOcean, LI.FI." Not OpenOcean's own docs. **Treat as unconfirmed.** |
| **ParaSwap** | Not found | Zero mentions across multiple searches. |
| **Robinhood-native aggregator "Meow"** | New finding, unverified | DefiLlama adapter PRs (#9639/#9640, third-party) describe a chain-native aggregator "Meow" routing across Uniswap v2/v3/v4, Sushi, PancakeSwap, Ramses, and **Pons**. Not Meow's own docs — flag for a follow-up primary-source check, don't cite as fact yet. |

**Pons/ponsfamily.com's own on-chain router — investigated two ways, still not conclusively identified:**

1. A research fork searched `docs.ponsfamily.com` and a third-party
   (`docs.bitquery.io`) source and got **two different, non-overlapping**
   address sets, neither confirmable via Blockscout (blocked by a Cloudflare
   bot-check on every fetch attempt from the fork's environment).
2. I then checked **both** sets directly against the chain via `cast code`
   over the direct RPC (`RH_RPC_URL_PAID`), which is a *different* domain
   than Blockscout and isn't behind Cloudflare — this succeeded where the
   fork's Blockscout attempts failed. **Every single address in both sets
   has real, non-empty bytecode on mainnet 4663:**

   - bitquery set: Factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`
     (48,356 bytes), Router `0xe33e9e479df8802cb0866d5d05258bec4cf62948`
     (8,834 bytes), Hook `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044`
     (30,336 bytes), Locker `0x267444d099b10fb5ed7c3cc7b7c767adca574952`
     (3,940 bytes).
   - ponsfamily.com-docs set: Factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`
     (48,708 bytes), Locker `0x736D76699C26D0d966744cAe304C000d471f7F35`
     (10,854 bytes), Swap router `0xCaf681a66D020601342297493863E78C959E5cb2`
     (48,996 bytes).

   So **both sets are real, live contracts** — this doesn't prove either is
   *current production* infrastructure (a project can have deprecated
   contracts with code still sitting at the address forever), and I did not
   confirm bytecode/ABI overlap with any known router (e.g. against the
   verified fork UniversalRouter's own bytecode) in the time available. If
   which-router-Pons-uses matters for a specific decision later (rather than
   as generic "does a custom-router pattern work on this chain" reassurance,
   which it already answers — yes, both sets prove custom per-chain routers
   deploy and hold real code here), the next step is a human pulling one real
   Pons swap tx hash from their own wallet history and decoding it, not
   another docs search.

### Venue depth for the 16 stock quote-asset candidates + WETH/USDG/cbBTC

`docs/exit-liquidity-table.md` (2026-09-17, GeckoTerminal-sourced, address-keyed
not ticker-keyed) already covers SGOV/NVDA/TSLA/GOOGL/AAPL/MSFT/AMZN/META/SPY/QQQ
at $1k/$10k sizes with GREEN/AMBER/RED classification (reused in §2's table
above). A second research pass extended the same methodology (GeckoTerminal,
network `robinhood`, resolved strictly by contract address — several
ticker-alike memecoin pools, e.g. `PUR/AMD`, `SAYLORMOON/MSTR`,
`DUKEINU/ORCL`, showed up in raw pool lists and were excluded as noise, not
real routes) to the 6 batch-2 tickers plus cbBTC, at $500/$5,000 sizes:

| Asset | Direct WETH pool | Via-USDG pool (best) | Impact @ $500 | Impact @ $5,000 | Class |
|---|---|---|---|---|---|
| CRCL | $296.8K (0.25%, v4) | $2.03M (0.3%, v3) | 0.05% | 0.49% | 🟢 GREEN |
| cbBTC | $1.32M (0.3%, v3) | $1.05M (0.15%, v4) | 0.08% | 0.76% | 🟡 AMBER |
| MSTR | $553.9K (1%, v3) | $1.61M (0.25%, v4) | 0.06% | 0.62% | 🟡 AMBER |
| COIN | $589.1K (0.3%, v3) | $732.2K (1%, v4) | 0.14% | 1.37% | 🟡 AMBER |
| PLTR | $67.9K (0.3%, v3, thin) | $978.9K (1%, v4) | 0.10% | 1.02% | 🟡 AMBER |
| AMD | none found | $533.5K (1%, v4) | 0.19% | 1.87% | 🔴 RED |
| ORCL | none found | $144.5K (1%, v4) | 3.46% | 6.92% | 🔴 RED |

All figures are constant-product estimates from GeckoTerminal reserves
(`2 × tradeUSD / reserveUSD`), same method as the original table, **not**
Quoter-simulated — stated plainly, not implied to be exact. AMD and ORCL both
have no real direct-WETH pool (same structural gap as AMZN in the original
table); ORCL is the thinnest asset found across either research pass, over
10x further from GREEN than the next-worst. PLTR's only real depth is via
USDG — its direct WETH pool is real but too thin to rely on. Surprising
result: cbBTC's deepest local pool ($1.32M) is unremarkable relative to its
$7.5B global circulating supply (Chainlink CCIP/Coinbase's own announced
figure) — the cross-chain bridge exists, but two-sided market depth
specifically on Robinhood Chain hasn't caught up to it yet.

### cbBTC — sourced and verified (was previously unfound anywhere in this repo)

Not in any existing doc. Found via **Chainlink's own CCIP Directory REST API**
(`docs.chain.link/api/ccip/v1/tokens?environment=mainnet`, a primary source —
the same authority `docs/robinhood-chain-research.md` already cites for price
feeds) and independently confirmed live on-chain:

- **Token:** `0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4` — confirmed via
  direct `eth_call`: `symbol()` → `"cbBTC"`, `name()` → `"Coinbase Wrapped
  BTC"`, `decimals()` → `8`.
- **CCIP token pool (burn-mint):** `0x402430ca607c52a99Aa82AB4C726001D4203C9e7`
  (from the same Chainlink API response — not independently re-verified
  on-chain tonight, lower confidence than the token address itself, but
  sourced from Chainlink's own directory rather than guessed).
- Chainlink's CCIP directory lists Robinhood Chain as a `burnMint` pool type
  (vs. Base's `lockRelease`), consistent with the public Chainlink/Coinbase
  announcement (`chainlinktoday.com`, 2026-08-27) that cbBTC expanded to
  Robinhood Chain via CCIP, Base as the sole destination for now
  (`destinations: ["8453"]` in the same API response).

---

## 4. Item 4b — proposed router architecture (PROPOSE→WAIT)

Given §4a found **zero confirmed fixed router/settlement address for any
third-party aggregator** on this chain, and BallastRouter's own spec (4c)
requires leg 1 to call "ONLY constructor-fixed router addresses, never
arbitrary user-supplied targets" — I'm recommending a **narrower v1 than the
original three-way (aggregator-primary / direct-fallback) design**, and
flagging this as the one open decision in this whole section.

### Recommendation: ship v1 with direct-pool routing only; defer aggregator integration

- **Leg 1 (tokenIn → quote asset), v1:** route only through pools we can
  verify by address tonight — the same fork UniversalRouter
  (`0x8876789976dEcBfCbBbe364623C63652db8C0904`, independently verified on
  Blockscout *and* proven by real execution earlier this session) for
  Uniswap v3/v4 legs, plus the same non-custodial, one-shot-callback pattern
  proven tonight via `RamsesSwapHelper` for direct Ramses v3 pools where that's
  the deeper venue. Both of these are addresses this session has *actually
  executed against*, not looked up in a doc.
- **Leg 1, deferred to v1.1:** once a human confirms a specific aggregator's
  settlement address is genuinely fixed (not a per-quote/per-tx address like
  0x's Allowance Holder pattern can be) and gets written into `.env.example`,
  redeploy `BallastRouter` with that address added as a second constructor-fixed
  target. Router redeploys are explicitly cheap by design (no owner, holds
  nothing between calls, frontend just points at the new address) — this
  is exactly the scenario that design goal exists for.
- **Leg 2 (quote asset → Ballast token):** always the verified fork
  UniversalRouter against the Ballast v4 pool, single-hop
  `ExactInputSingleParams`, `minHopPriceX36 = 0`, actions
  `[0x06, 0x0c, 0x0f]` — the exact encoding already proven against a live
  pool tonight for HARUNA. No open question here.
- **Skip leg 1** when `tokenIn == quoteAsset` (a straight leg-2-only call) —
  as specified.
- **Two-pool launches:** the frontend (§4d) queries `V4Quoter` against both
  pools before submitting and passes the better one as `quoteAsset` — the
  contract itself doesn't need to choose, since `buy()`'s signature already
  takes `quoteAsset` as an explicit argument.

### Why not aggregator-primary in v1

0x is the aggregator with the clearest fit (Robinhood's own chain docs
already point to 0x RFQ for exactly this asset class), but every
aggregator's *typical* architecture (0x's Allowance Holder / Permit2-based
flow, 1inch's per-quote router selection) returns calldata targeting an
address resolved **per quote**, which several of these vendors document as
stable across quotes in practice but none of the fetched pages tonight stated
is contractually fixed forever. `BallastRouter`'s core security invariant —
"leg 1 calls only a constructor-fixed target, never a user-supplied one" —
exists specifically so a malicious `leg1Data` can't redirect funds to an
attacker contract. If the "fixed" aggregator address in practice rotates on
their side, every future rotation needs a router redeploy anyway (same cost
as adding a *new* aggregator), so there's no v1 velocity lost by deferring
this one integration until a human pulls the real, current address from that
vendor's own dashboard/support channel rather than their public marketing
docs — which is exactly the kind of "stop and ask for a credential/account
detail" case `CLAUDE.md`'s "Division of labour" section already covers.

**DECIDED (user, 2026-09-26): ship v1 direct-pool-only.** Aggregator
integration is deferred to a future v1.1 router redeploy once a human
confirms a specific vendor's settlement address is genuinely fixed.

---

## 5. Item 4c — `BallastRouter.sol` spec (design only, not implemented)

```solidity
// Sketch signatures — not the actual file. No contract code this phase.

function buy(
    address tokenIn,
    uint256 amountIn,
    address quoteAsset,
    bytes calldata leg1Data,   // empty if tokenIn == quoteAsset
    uint256 minOut,
    uint256 deadline
) external returns (uint256 out);

function buyWithETH(
    address quoteAsset,
    bytes calldata leg1Data,
    uint256 minOut,
    uint256 deadline
) external payable returns (uint256 out);

function sell(address ballastToken, uint256 amountIn, address quoteAsset,
              address tokenOut, bytes calldata leg2Data, uint256 minOut,
              uint256 deadline) external returns (uint256 out);

function sellToETH(address ballastToken, uint256 amountIn, address quoteAsset,
                    bytes calldata leg2Data, uint256 minOut, uint256 deadline)
    external returns (uint256 out);
```

Invariants (from the spec, cross-checked against tonight's proven patterns):

- **Constructor-fixed targets only.** `leg1Data`/`leg2Data` select *which*
  pool/venue among a small, constructor-set list (e.g. an enum or bounded
  index), never an arbitrary `(target, calldata)` pair. This is stricter than
  "allowlist a target address" — it means the contract's own code enumerates
  the possible calls, `leg1Data` only carries parameters (pool key, fee tier,
  direction), matching how `RamsesSwapHelper` and the verified fork router
  calls were built tonight.
- **Delta measurement, never trust return values.** Balance of the quote
  asset is read before and after leg 1; that delta, not any aggregator's
  quoted/returned number, is what feeds leg 2. This is also what makes
  fee-on-transfer tokens behave correctly automatically — the actual received
  amount is always what's forwarded, so there's nothing to "detect," and if
  the fee eats enough that final `minOut` isn't met, the whole call reverts
  like any other slippage failure (never a half-executed, stuck-mid-route
  state). Rebasing tokens should still be **explicitly rejected upfront** (a
  `balanceOf` check against a denylist or a supply-invariant check at
  entry) since a rebase *during* the call — not just between calls — could
  move the leg-2 input after it's already been computed from leg 1's delta,
  which is a different failure mode than a static transfer fee.
- **`minOut`/`deadline` apply to the final output only.** Leg 1 is
  unprotected individually; a sandwich attack against leg 1 alone still has
  to survive the end-to-end `minOut` check to succeed, but that's a real,
  intentional gap for the aggregator case specifically (an aggregator's own
  quote already embeds its slippage tolerance) — for the v1 direct-pool
  case, worth adding an internal soft bound on leg 1 too, since we're not
  relying on an external quote there. **Flagging this as a v1 addition**,
  not in the original spec text but consistent with its intent.
- **Exact approvals, reset to zero after each call.** No `approve(x,
  type(uint256).max)` anywhere; every leg approves exactly the amount needed,
  then zeroes the approval afterward — matches Permit2's own
  exact-amount-and-expiry model, already proven working tonight for the
  WETH→Permit2→UniversalRouter leg.
- **End-of-call zero-balance assertion.** `assert(balanceOf(tokenIn) == 0 &&
  balanceOf(quoteAsset) == 0 && balanceOf(ballastToken) == 0 &&
  balanceOf(weth) == 0)` before returning, with any nonzero dust returned to
  `msg.sender` first rather than the assertion firing on real dust — i.e.
  "sweep then assert," not "assert then hope."
- **No owner, no pause, no upgradeability, holds nothing between calls.**
  Confirmed as achievable given everything above is either a constructor
  constant or a per-call local — there's no state this contract needs to
  retain, which is what makes "redeploy to add a route" actually cheap in
  practice, not just in theory.
- **Permit2 for ERC-20 `tokenIn`.** Canonical address
  `0x000000000022D473030F116dDEE9F6B43aC78BA3` (already verified, already in
  use this session).

---

## 6. Item 4d — frontend token-selector spec

- **"You pay" picker**, ETH preselected/default. Two sections:
  - **CRYPTO** — ETH, WETH, USDG, cbBTC, plus any other token with a
    currently-verified direct-pool route (per §4b's v1 scope) to this
    launch's quote-asset pool(s).
  - **SHARES** — the 16 stock tokens from §2's table, filtered the same way:
    only ones with a verified route show up at all. A token with no verified
    route is **never shown and then failing** — it's absent from the list.
- **Search** by symbol/name over the visible (route-verified) set only.
- **Paste-an-address** input, always available, bypassing the curated list —
  shows an explicit "unverified token — you are responsible for confirming
  this is the token you intend to trade" warning, never silently treated as
  equivalent to a curated entry. This mirrors the ticker-impersonation lesson
  from the GOOGL pool finding: curation is the safety mechanism, so anything
  that bypasses curation needs its own explicit warning, every time.
- **Per-token balance** shown inline in the picker.
- **Route displayed as text**, e.g. `"USDG → NVDA → HARUNA"` for a two-leg
  route or `"Direct"` for a one-leg route — sourced from which `leg1Data`
  variant was selected, not a generic "via aggregator" string, since v1 has
  no aggregator leg to describe yet.
- **Price impact + total fees** (Ballast's 1% hook fee, plus, once v1.1 adds
  an aggregator leg, that vendor's own fee) shown before signing.
- **Default slippage:** 0.5% for a single-leg (direct) route, 1.0% for a
  two-leg route — user-adjustable.
- **Quote refresh:** periodic while the panel is open, and once more
  immediately before the wallet signature prompt; if the fresh pre-sign quote
  breaches the user's slippage tolerance, block the signature and show the
  new quote for re-confirmation rather than letting a stale number reach the
  wallet.
- **Sell side mirrors this exactly** — "You receive" picker, ETH default,
  same CRYPTO/SHARES split, same route text, same refresh-before-sign
  behavior.

---

## 7. Exact-out sell support — bundling decision (carried over from `docs/GO_LIVE.md`)

`docs/GO_LIVE.md` already recorded that the current hook's
`SellExactOutNotSupported()` revert is permanent under the current fee-timing
design (fee computed from the specified amount in `beforeSwap`, which is the
*output* on an exact-out sell — wrong basis for a partial fill) and asked
that a fix be scoped into whichever hook redeploy happens next, to avoid
paying the "new hook address → new `HISTORICAL_HOOKS` entry, another round of
prior-hook-mapping risk" cost twice.

**Correction (§0):** a hook deploy is happening in this package regardless —
the multi-quote-asset hook (`dccbc8e`) has never been deployed, so shipping
items 5/6 at all means deploying it for the first time. The real question
was never "redeploy the hook or not," it's "fold the exact-out fix into this
already-necessary first deployment, or ship that hook exactly as already
written and let exact-out wait for a THIRD hook generation later."

**DECIDED (user, 2026-09-26): leave the hook alone this round.** Ship the
multi-quote-asset hook exactly as already written in the repo — no
exact-out-sell fix folded in. Exact-out sell support stays queued in
`docs/GO_LIVE.md` for whenever the next independent reason to redeploy the
hook comes up.

---

## 8. `docs/COMBINATION.md` — public one-pager (drafted separately)

Written as its own file — see `docs/COMBINATION.md`, created alongside this
report.

---

## 9. Phase-3 fork test plan (for when this design is approved)

Scoped to exactly what was asked, no more:

1. **Opening-valuation assertion**, across every combination of
   `{no deposit, deposit < 1 ETH, deposit > 1 ETH}` × `{WETH, NVDA, WETH+NVDA,
   WETH+SPY}` (12 cases): graduate each, read every seeded pool's `slot0` via
   `StateView`, convert each pool's tick to a real price, convert that price
   to ETH terms via the same ETH/USD + stock feeds the factory itself reads,
   and assert the resulting fully-diluted market cap equals 1 ETH within the
   one-tick tolerance derived in §1.
2. **Router buy/sell**, ETH/WETH/USDG/one-stock-token as `tokenIn`/`tokenOut`,
   into both a WETH-quoted and a stock-quoted launch (so 4 `tokenIn` values ×
   2 pool types × buy-and-sell = 16 directed cases at minimum).
3. **Impossible-`minOut` reverts**, both buy and sell directions.
4. **Zero-balance assertion** after every one of the router calls above —
   not just the happy-path ones, the reverting ones too (state must be
   fully unwound on revert, but worth asserting the *balance* invariant
   holds on the *successful* calls specifically, since that's the one this
   report's spec calls out by name).
5. **Expired-`deadline` reverts.**
6. **A call targeting a non-allowlisted address reverts** — construct
   `leg1Data`/`leg2Data` that tries to point at an address outside the
   router's constructor-fixed set and confirm the call reverts before any
   token movement, not partway through.

---

## 10. Risks worth flagging to an external reviewer before real volume

1. **No aggregator leg confirmed yet (§4b).** v1 ships direct-pool-only;
   anyone reviewing should know "pay with any token" is currently "pay with
   any token that has a *direct* verified pool route," not literally any
   ERC-20, until a v1.1 redeploy adds an aggregator.
2. **Pons/Meow's exact on-chain infrastructure is still unconfirmed**
   (§4a) — two candidate address sets are proven *live* but neither is
   proven *current/correct*. Low risk to Ballast directly (we don't depend
   on Pons's contracts), but worth resolving before citing Pons as a
   reference architecture in any external-facing material.
3. **AMBER/RED quote assets becoming factory-selectable (§2).** Item 6 asks
   for all 16 assets allowed at the contract level, with only a frontend
   warning distinguishing "reachable with any token" from "holders only."
   A creator can still pick AMZN (documented single-route/RED liquidity) as
   a quote asset for real — the contract has no floor stopping a thin quote
   asset from being chosen; this was already true for GREEN-only assets in
   principle (nothing stops a creator picking SGOV+NVDA and ending up with
   two half-depth pools instead of one deep one) but widening the pool of
   candidates widens the pool of bad choices too. This is a UX-warning
   mitigation, not a contract-level one — worth an external reviewer's eyes
   on whether that's sufficient.
4. **cbBTC's CCIP token-pool address (`0x402430ca...`) is sourced from
   Chainlink's API but not independently re-verified on-chain tonight**,
   unlike the token address itself (which was). Low stakes for this report
   (BallastRouter never calls the CCIP pool directly — it only ever touches
   the token itself), but don't reuse that pool address elsewhere without
   re-confirming it.
5. **Rebasing-token rejection (§5, `BallastRouter` spec) needs a concrete
   mechanism**, not just a stated intent — this report proposes a
   balance/supply-invariant check at entry but that's a design sketch, not
   a verified-sufficient guard; worth dedicated adversarial-test attention
   in Phase 3 rather than treating the sketch as settled.
6. **AMD and ORCL have no real direct-WETH exit (§3)**, the same structural
   gap AMZN already had in the original table. If either is ever promoted to
   factory-allowed (which item 6 does for all 16 regardless of color), a
   holder's realistic exit is via USDG only — worth the same "holders only"
   frontend treatment AMZN already gets, not a softer one just because it's
   newly added.

---

## 11. Phase 3 status (2026-09-26) — built, tested, not deployed

Following the user's decision (ship v1 direct-pool-only; leave the hook
alone): `BallastFactory.sol` (items 5+6), `BallastRouter.sol`, and
`contracts/interfaces/IPermit2.sol` are written and compile clean. Test
coverage delivered on a real mainnet fork (not mocks where a real venue
exists):

- `BallastGraduateFork.t.sol`: rewritten — 12/12 pass, including the
  fixed-1-ETH invariance proof (fuzzed across backing size, feed decimals,
  ETH/USD price), the WETH-vs-stock-quoted feed-staleness split, and the
  informational-backing-sum non-reverting behavior.
- `BallastRouterFork.t.sol` (new): 7 tests against REAL mainnet liquidity —
  buy with ETH and with real NVDA (via the verified NVDA/WETH pool) into a
  freshly graduated WETH-quoted pool, sell to ETH, impossible-minOut revert,
  expired-deadline revert, unknown-route reverts, end-of-call zero-balance
  assertion. This is a representative subset of §9's full matrix, not the
  complete one — stock-quoted-pool routing and the full 12-case opening
  matrix are covered by BallastGraduateFork's tests separately, but a
  router buy/sell into a STOCK-quoted pool specifically wasn't run.
- Full existing suite: 188/189 pass. The one failure
  (`test_liquidityLock_seederBlocked_thirdPartyFree` in
  `BallastHookFork.t.sol`) is **pre-existing and unrelated** — that file was
  never touched this session (confirmed via `git status`), and the failure
  reproduces in isolation on an unmodified checkout.

**Corrected understanding, materially changes the deploy story (§0):** the
multi-quote-asset generation (Seeder/Hook/Factory) has never been deployed at
all — confirmed by reading the live factory directly (`isGreenQuoteAsset`
and `ethUsdStaleWindow` both revert, meaning the deployed bytecode predates
those functions) and by `git log` (no `DeployMainnet.s.sol`/`DeployHook.s.sol`
changes since before the multi-quote-asset commits). `docs/BALLAST-build-spec.md`
and prior session notes describing this as a "redeploy" undersold it: it's a
first-ever deployment of Hook + Seeder + Factory together, with items 5/6
folded into that same first deploy. Written as
`contracts/script/DeployCombinationPackage.s.sol` (write-only, not run).

**Two things need a human answer before that script can run:**

1. **Which FeeConfig should the new hook use?** Confirmed on-chain: the
   CURRENTLY LIVE hook (`0x9C15c992E4De3711715C8B7D717EF46e474680CC`) uses
   `0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304`; a second, DIFFERENT
   FeeConfig (`0xC0B895bc683bf4ACA30c7277D42d068E0973A594`) is used by an
   abandoned second-generation hook that is NOT the current env pointer.
   These are two real, different, live contracts and I can't tell from any
   doc or on-chain signal which one reflects your actual current intent for
   fee split/vault — or whether the new hook should get a brand-new
   `FeeConfig` instead. The script supports all three options via env
   (`FEE_CONFIG_ADDRESS` to reuse either, or `NEW_FEE_CONFIG_OWNER`/`_VAULT`
   to deploy fresh) but defaults to none — it will refuse to run without an
   explicit choice.
2. **BallastRouter's v1 route list is intentionally small** — only
   NVDA/WETH and SPY/WETH (both re-verified on-chain), the only two curated
   assets with a real single-hop-strong direct-WETH pool. SGOV's GREEN
   rating specifically depends on a two-hop via-USDG path, which v1's
   single-leg leg-1 can't use — it's deliberately excluded from the router
   for now rather than routed through its thin ($141.9K) direct pool. Same
   reasoning kept CRCL/cbBTC/MSTR/COIN/PLTR out of v1 (their addresses
   weren't independently re-verified against a same-hop-strong pool this
   session) — adding any of them is a cheap router redeploy once sourced.

**Not yet done:** the deploy + Blockscout-verify tutorial (dry run →
broadcast → verify, keystore account) and the exact Vercel env change list —
next, once the FeeConfig question above is answered, since the tutorial's
exact steps depend on that choice.
