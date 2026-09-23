# GO_LIVE.md — path to multiple stock pairs actually trading

Written 2026-09-23. Reflects the real state of `feat/manatee-mint` as of commits
`9a62a68` (quote-asset-aware swaps, batch-2 sourcing) and `275e899` (hero orbit
fix) — not the original pasted brief's architecture, which this branch already
superseded (see `ASSUMPTIONS.md`).

**The two questions you told me not to skip, answered up front, not buried:**

1. **Liquidity.** Nobody supplies the quote-asset (NVDA/SPY/SGOV) side of a pool,
   ever, by design. `BallastSeeder` is a strictly ONE-SIDED liquidity seeder — the
   creator's token is the only thing deposited at graduation (an even split of
   the token's 1B supply across however many quote-asset pools they picked). The
   NVDA/SPY/SGOV side of the pool starts at **exactly 0** and is filled *only* by
   real buyers paying in that asset. There is no number to give for "initial
   NVDA liquidity" because the honest number is zero — see §Liquidity below for
   what that actually means in practice and the one lever you have to change it.
2. **The buy side.** Today, with no multi-hop routing built: **an ordinary
   visitor holding only WETH cannot buy a token that graduated only against
   NVDA, through the Ballast UI. They can't.** They would have to leave the
   product, acquire NVDA somewhere else, then come back. This is step 1 in the
   table below, owned by AGENT, gated on a HUMAN-supplied stable RPC to prove it
   before it ships.

---

## Ground truth this plan is built from (verified this session, not assumed)

| Fact | Value |
|---|---|
| AssetRegistry (live, unchanged by any of this) | `0x427764d0d19aB765c35A41A5aa4771580307dA81` — 10 assets live today |
| Current factory (WETH-only, no multi-quote-asset support) | `0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1` |
| Prior factory (same limitation) | `0x069974136c78Cf0F2162463B95321E59F56523D8` |
| BallastSeeder (reused, not redeployed) | `0x7830E1F67598e8c76ce1fFf79b1D2A3E915325E4` |
| BallastHook (reused, not redeployed) | `0x743102aa1De955b5F0Fada1377B6E545Fdb080cc` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| ETH/USD feed | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` |
| GREEN quote assets (hardcoded in `DeployMainnet.s.sol`, already written) | SGOV `0x92FD…9B5`, NVDA `0xd060…EEC`, SPY `0x117c…C0C` |
| Batch-2 treasury assets sourced + independently verified this session | AMD, COIN, PLTR, ORCL, MSTR, CRCL — addresses in `.env.example` |
| Batch-2 assets that cannot ever be added | AVGO, HOOD, NFLX, MCD — no Chainlink feed exists for them on this chain, checked exhaustively |
| Free public RPC's local-fork state retention | Too short for a multi-step `anvil --fork-url` test (confirmed by direct failure this session) — a paid/stable RPC is required for any local proof step below |

---

## The plan

| # | Step | Owner | Blocked by | Definition of done | Cost / time |
|---|---|---|---|---|---|
| 1 | Build WETH→quote→TOKEN multi-hop swap encoding + wire into `useSwap`/`SwapPanel` (the fix for "the buy side," per the answer above) | **AGENT** | Nothing — can start now | `contracts/src/interfaces/IRobinhoodV4Router.sol`'s documented multi-hop `ExactInputParams` shape implemented in `web/lib/swap.ts`; a `ProveMultiHopSwap.s.sol` script (mirroring `ProveMultiQuoteSwap.s.sol`) that runs a real WETH→NVDA(external pool)→TOKEN swap and asserts token balance increases | Free (my time). Tonight, code-only. **Cannot be verified tonight** — step 2 blocks the proof |
| 2 | Prove step 1's multi-hop swap against real chain state | **HUMAN** | Step 1 code written | Run `forge script script/probe/ProveMultiHopSwap.s.sol --rpc-url $STABLE_RPC` against a fork of a **paid** RPC (NOT the free public one — it will hit the same "historical state not available" wall I hit this session). Expected output: `=== ALL CHECKS PASSED ===`, ending with a nonzero token balance delta | **Needed in hand:** an Alchemy/Infura-style RPC URL for chain 4663 with normal archive retention (a few dollars/month on any provider's free-to-low tier). No funds needed — this runs on a local fork, not mainnet. ~15 min once the RPC exists |
| 3 | Deploy the new multi-quote-asset `BallastFactory` | **HUMAN** | Nothing (independent of 1–2) | `forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url $RH_RPC --account <deployer> --broadcast` prints a new factory address; `cast call <addr> "MAX_QUOTE_ASSETS()(uint256)"` returns `4` (today it reverts on both live factories — that's the proof this one is new) | **Needed in hand:** funded deployer wallet (gas only, in ETH — the chain's native gas token), `PROTOCOL_OWNER_ADDRESS`/`PROTOCOL_VAULT_ADDRESS`/`ETH_USD_FEED` env vars already documented in the script's header comment, RPC access (the free public one is fine for a single deploy tx — the retention problem is specific to multi-step local forks, not single broadcasts). **Cost:** unverified current gas price on this chain — run `cast gas-price --rpc-url $RH_RPC` immediately before deploying and multiply by ~4M gas (the factory's deploy cost, measured this session on a fork) rather than trust a number here; on any Arbitrum-Orbit L2 this has historically been low single-digit dollars, but confirm live, don't assume |
| 4 | Verify the new factory's source on Blockscout | **AGENT** | Step 3 (needs the deployed address) | `forge verify-contract <addr> src/BallastFactory.sol:BallastFactory --chain-id 4663 --verifier blockscout --verifier-url $BLOCKSCOUT_URL --constructor-args $(cast abi-encode ...)` — Blockscout's contract page shows a populated "Code" tab, not "not verified." No private key needed for this step, only the address, which the human hands me after step 3 | Free, ~5 min, immediately after step 3 |
| 5 | Add the new factory to the frontend's factory union | **AGENT** | Step 3 (needs the address) | Diff to `.env.example`/deployment notes showing `NEXT_PUBLIC_FACTORY_ADDRESS=<new>` and `NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES=<old current>,<old prior>` (newest-first) — this is a config diff I write, not something I can set on the live Vercel project myself | Free, ~5 min |
| 6 | Set the new env vars on the actual Vercel project and redeploy | **HUMAN** | Step 5 | Vercel dashboard (or `vercel env add` / `vercel --prod`) shows `NEXT_PUBLIC_FACTORY_ADDRESS` updated for Production; the live site's `/app/create` quote-asset picker shows SGOV/NVDA/SPY as selectable (not just WETH) — this is the actual on-the-record proof, check it in a browser | **Needed in hand:** Vercel project access (you already have this — no new credential). ~10 min including redeploy wait |
| 7 | Broadcast the 6 verified batch-2 assets to `AssetRegistry` (the "allowlist transactions" / "registry seeding" step — same action, one script) | **HUMAN** | Nothing (independent of 1–6, `AssetRegistry` isn't touched by the factory redeploy) | `cd web && npx tsx scripts/setAssets.ts --broadcast` (env vars for the 6 `TOKEN_*`/`FEED_*` pairs already in `.env.example`) → script prints `=== allowedAssets() now returns 16 asset(s) ===`. Confirm independently: `cast call 0x427764d0d19aB765c35A41A5aa4771580307dA81 "allowedAssets()(address[])" --rpc-url $RH_RPC` returns 16 addresses, not 10 | **Needed in hand:** the AssetRegistry owner's private key (`DEPLOYER_PRIVATE_KEY` in the script's env), RPC access. **Cost:** 6 `setAsset` calls, each cheap on an L2 — same gas-price caveat as step 3, but this is ~6 small txs, not a deploy; expect it to be far cheaper than step 3 in total |
| 8 | The first real launch through the new factory | **HUMAN** | Steps 3, 6 (needs the new factory live in the UI) | Use `/app/create` to launch a real project selecting at least one GREEN quote asset (NVDA, SPY, or SGOV) alongside or instead of WETH. Definition of done: `cast call <newFactory> "launchCount()(uint256)"` increments by 1, and `quoteAssetsOf(<newToken>)` returns the chosen array including the non-WETH asset | This is a real product/business decision (whose project launches first, with what backing), not something I should do unprompted. **Cost:** launch itself is cheap gas; if backed, the creator also deposits real treasury assets — that's a separate, creator-specific cost outside this plan's scope |
| 9 | Graduate that launch, seeding its pool(s) | **HUMAN** | Step 8 | `graduate(token)` succeeds; `PoolSeeded` event fires once per quote asset chosen; `cast call <StateView> "getLiquidity(bytes32)(uint128)"` on the computed NVDA-pool `PoolId` returns > 0 | Cheap gas, minutes after step 8. **Needed in hand:** same wallet as step 8, no new credential |
| 10 | The first real swap on a stock-quoted pool | **HUMAN** | Step 9, and step 1–2 if the buyer holds WETH (see below) | A `execute()` transaction on the UniversalRouter that mints the launched token in exchange for NVDA (or SGOV/SPY), confirmed via the token's `Transfer` event to the buyer's address. **If the buyer holds WETH, not NVDA:** this step is blocked until steps 1–2 ship — see §The buy side |
| 11 | Monitoring: build it | **AGENT** | Nothing, can happen in parallel with 1–10 | A script/dashboard reading, per live GREEN-quoted pool: `getLiquidity`, `getSlot0`, and a simple "is this pool's quote-asset side still 0" flag (the exact cold-start signal described in §Liquidity) — this is new code, doesn't exist yet | Free, a few hours of agent time |
| 12 | Monitoring: watch it | **HUMAN** | Step 11 | Ongoing — this is an operational habit, not a one-time deliverable. No "done" state | Ongoing, unquantifiable |

**Why "allowlist transactions" and "registry/config seeding" are one row (step 7), not two:** I checked whether the new factory needs to register itself anywhere else — `BallastSeeder.seed()` is fully permissionless (no factory allowlist to update), and `BallastHook` recognizes a Ballast-launched token by a discriminator, not by trusting a specific factory address, so neither needs a config update when a new factory goes live. The only registry that genuinely needs new writes is `AssetRegistry` (the treasury allowlist) — that's step 7 in full.

---

## §Liquidity — the number, not "seed the pool"

- **Token side (what the creator supplies):** exactly `1,000,000,000 / N` tokens
  per quote-asset pool, where N is however many quote assets that launch chose
  (1–4). This is enforced in code (`BallastFactory.graduate()`'s even split) —
  not negotiable, not something either of us sets manually.
- **Quote-asset side (NVDA/SPY/SGOV):** **zero**, supplied by nobody, at
  graduation. `BallastSeeder`'s one-sided design means the pool opens with
  liquidity on ONE side only (the token), spanning from the opening price P0 up
  to ~1000×P0. The NVDA/SPY/SGOV side only exists once a real buyer pays into
  it. This is not a bug or an oversight — it's the same mechanism that makes
  the WETH-quoted pools work today, extended unchanged to the new quote assets.
- **What this actually means:** the very first trade against a fresh
  NVDA-quoted pool has to be a BUY (there's nothing to sell into yet), and that
  first buyer's NVDA payment IS the pool's entire NVDA-side depth immediately
  afterward. A tiny first buy leaves the pool extremely thin; price impact on
  the second buy could be large.
- **The one lever you actually have, if you want the first buyer's experience
  to not be "I moved the price 40%":** have the team itself be buyer zero.
  Concretely: acquire some NVDA externally (Robinhood's own app, or the real
  NVDA/WETH Uniswap pool already on this chain — ~$1.27M depth per
  `docs/exit-liquidity-table.md`, so buying a few hundred to a couple thousand
  dollars of NVDA there has negligible impact), then execute a normal Ballast
  buy with it right after graduation. A reasonable seed amount to not look thin
  on a Discover page: **$500–$2,000 of NVDA**, spent by the team as an ordinary
  buyer, not as a protocol mechanism. This is a real money decision — **HUMAN
  step**, not something I can size more precisely without knowing your risk
  appetite, and not a step I've added a row for above because it's optional
  polish, not a blocker to "pairs trading."

## §The buy side — the literal, current answer

Today, with the code that exists right now (before step 1 above ships):

> **An ordinary visitor holding only WETH cannot buy a token that graduated
> only against NVDA, through the Ballast UI. They can't.**

The only path available today: the visitor has to leave Ballast, acquire NVDA
somewhere else (Robinhood's own app, or a third-party DEX swap against the real
NVDA/WETH pool), bring it back to their wallet, and only then can they use
Ballast's trade page — which, after this session's earlier work, already
supports paying with NVDA directly for an NVDA-quoted pool. What's missing is
purely the "start from WETH" convenience leg. Step 1 above is that fix, and it
is explicitly *not done tonight* — it needs the proof step (step 2), which
needs a stable RPC I don't have access to from here.

**Mitigation available with zero new code, if steps 1–2 slip:** creators can
simply include WETH as one of their (up to 4) chosen quote assets alongside
NVDA/SPY/SGOV. A token launched against both WETH and NVDA has a direct
WETH-quoted pool too, and the buy-side problem disappears for that token
specifically — at the cost of splitting the seeded token supply across one
more pool (see §Liquidity: N pools means 1B/N tokens each, so more pools means
thinner tokens-side depth per pool). This is a product-policy decision, not a
code change — worth deciding explicitly, in writing, rather than leaving
creators to discover the gap themselves.

---

## What's explicitly NOT in this plan

- Batch-2 assets AVGO, HOOD, NFLX, MCD — permanently blocked until Chainlink
  publishes a feed for them on this chain. Nothing either of us can do about
  it tonight or any night until that changes upstream.
- Promoting AMBER quote assets (TSLA, GOOGL, AAPL, META, QQQ, MSFT) to GREEN —
  `docs/exit-liquidity-table.md` explicitly says these need a real
  Quoter-simulated re-review before promotion, not a rubber stamp. Not
  scheduled here; a separate decision when someone does that review.
