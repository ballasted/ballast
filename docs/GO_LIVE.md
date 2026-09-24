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

## One launch, multiple quote assets — answered from code (`BallastFactory.sol`, `605eb27` through tonight), not from docs

- **Yes, simultaneously — not a choice between one or the other.**
  `launch(..., address[] calldata quoteAssets_)` takes an array, rejects
  duplicates, and stores the whole thing on ONE `Launch`. Picking
  `[WETH, NVDA]` means both, not either.
- **Yes — one pool per quote asset, same token.** `graduate()` loops over
  `l.quoteAssets` and calls `seeder.seed(token, quoteAsset, ...)` once per
  entry, each producing a genuinely different `PoolKey` (the quote asset is
  part of the key). N quote assets chosen at launch = N separate pools at
  graduation, all trading the same token.
- **Split: even, by count, remainder to the first pool.**
  `share = supply / n; amount = i==0 ? supply - share*(n-1) : share;`. Two
  quote assets → 500M/500M (first pool gets any leftover from integer
  division, by design, so nothing is dust-lost — not because the first pool
  is special otherwise). Reverified against a REAL fork run tonight at n=2
  (`BallastGraduateFork.t.sol::test_multiQuoteAsset_graduate_seedsAllPools_equalSplit_isolatedFeeLedgers`,
  passes against live mainnet state, not mocks) — both pools seeded with
  the correct even split, isolated fee ledgers, no cross-pool leakage.
- **What used to stop fragmentation into several shallow books: nothing.**
  At `MAX_QUOTE_ASSETS = 4`, I read `launch()`/`graduate()` end to end
  looking for a minimum-per-pool check, a liquidity floor, anything — there
  wasn't one. A creator could pick 4 and get four 250M-token pools with zero
  pushback, a real, live footgun, not a hypothetical.
  **This finding directly motivated the fix, applied tonight: `MAX_QUOTE_ASSETS`
  is now 2, in the contract, permanent before deploy** — see "Permanent
  parameters" below for the full reasoning. 1 is the clean case (undiluted
  depth); 2 is the legitimate case (one liquid quote for reach + one stock
  quote for the thesis, each visibly at half depth); 3–4 had no real use case
  and only fragmented further with no floor and no warning.
- **So "include WETH" in this plan means literally "add a WETH pool
  alongside the NVDA/SPY/SGOV pool already chosen,"** not "pick WETH instead
  of the stock" — and at MAX=2, "alongside" is now the ONLY other option:
  a launch is either 1 pool, or exactly 2 (its stock quote + WETH, or two
  stock quotes), never more.

## Permanent parameters — decided before deploy, unconditional after

Three values are fixed forever the moment a `ProjectTreasury` or
`BallastFactory` is deployed, with no owner setter and no upgrade path.
Getting any of them wrong costs a full redeploy, not a config change:

| Parameter | Value | Where it's fixed | Why |
|---|---|---|---|
| Treasury asset | chosen per-project at launch | `ProjectTreasury` constructor | The whole backing claim depends on it never moving |
| Notice period | 7 / 30 / 90 days, chosen per-project | `ProjectTreasury` constructor | The withdrawal-delay trust model collapses if a creator could shorten it later |
| `MAX_QUOTE_ASSETS` | **2** (was 4, changed tonight) | `BallastFactory.sol` constant, baked into the not-yet-deployed factory | An economic parameter dressed as a gas ceiling: every additional quote asset is a full extra pool carved from the SAME fixed token supply, with zero on-chain floor against fragmentation (see finding above). 1 = clean, undiluted. 2 = one liquid quote for reach + one stock quote for the thesis, each openly at half depth. 3–4 had no articulated use case and only bought thinner books with no warning. Changed now because it's free before the first deploy and permanent after — the exact "one launch, multiple quote assets" analysis above is what surfaced it. |

---

## The plan

| # | Step | Owner | Blocked by | Definition of done | Cost / time |
|---|---|---|---|---|---|
| 1 | Build WETH→quote→TOKEN multi-hop swap encoding + wire into `useSwap`/`SwapPanel` (the fix for "the buy side," per the answer above) | **AGENT** | Nothing — can start now | `contracts/src/interfaces/IRobinhoodV4Router.sol`'s documented multi-hop `ExactInputParams` shape implemented in `web/lib/swap.ts`; a `ProveMultiHopSwap.s.sol` script (mirroring `ProveMultiQuoteSwap.s.sol`) that runs a real WETH→NVDA(external pool)→TOKEN swap and asserts token balance increases | Free (my time). Tonight, code-only. **Cannot be verified tonight** — step 2 blocks the proof |
| 2 | Prove step 1's multi-hop swap against real chain state | **HUMAN** | Step 1 code written | Run `forge script script/probe/ProveMultiHopSwap.s.sol --rpc-url $STABLE_RPC` against a fork of a **paid** RPC (NOT the free public one — it will hit the same "historical state not available" wall I hit this session). Expected output: `=== ALL CHECKS PASSED ===`, ending with a nonzero token balance delta | **Needed in hand:** a QuickNode Robinhood Chain (4663) mainnet endpoint, **Build tier, $49/month** — see §RPC provider spec below for why this specific tier, verified against the providers' own pricing pages tonight. No funds needed beyond the subscription — this runs on a local fork, not mainnet. ~15 min once the endpoint exists |
| 3 | Deploy the new multi-quote-asset `BallastFactory` | **HUMAN** | Nothing (independent of 1–2) | `forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url $RH_RPC --account <deployer> --broadcast` prints a new factory address; `cast call <addr> "MAX_QUOTE_ASSETS()(uint256)"` returns `2` (today it reverts on both live factories — that's the proof this one is new) | **Needed in hand:** funded deployer wallet (gas only, in ETH — the chain's native gas token), `PROTOCOL_OWNER_ADDRESS`/`PROTOCOL_VAULT_ADDRESS`/`ETH_USD_FEED` env vars already documented in the script's header comment, RPC access (the free public one is fine for a single deploy tx — the retention problem is specific to multi-step local forks, not single broadcasts). **Cost:** unverified current gas price on this chain — run `cast gas-price --rpc-url $RH_RPC` immediately before deploying and multiply by ~4M gas (the factory's deploy cost, measured this session on a fork) rather than trust a number here; on any Arbitrum-Orbit L2 this has historically been low single-digit dollars, but confirm live, don't assume |
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
  (1 or 2 — see "Permanent parameters"). This is enforced in code
  (`BallastFactory.graduate()`'s even split) — not negotiable, not something
  either of us sets manually.
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
- **No liquidity mitigation is proposed here, on purpose.** The obvious lever —
  the team itself trading to seed initial depth — is off the table: **the team
  deliberately does not take a position in any launch.** That's a standing
  policy, not a gap I forgot to fill, so this document doesn't offer a "buyer
  zero" workaround. The one real fix in this plan is step 1 (multi-hop
  routing) — but be precise about what it fixes: routing makes a thin pool
  *reachable* to an ordinary WETH holder instead of reachable only to someone
  who already holds NVDA from elsewhere. It does **not** add a single unit of
  depth to the NVDA side. Thinness at launch is a permanent, disclosed
  property of one-sided seeding under this policy, not a bug this plan closes.
  If that's an acceptable cold start, nothing further is needed; if it isn't,
  the only compliant lever is a THIRD PARTY's independent decision to trade —
  which is exactly the same "no floor, no guarantee" posture the rest of the
  product already takes, applied consistently here too.

## §The buy side — the literal, current answer

Today, with the code that exists right now (before step 1 above ships):

> **An ordinary visitor holding only WETH cannot buy a token that graduated
> only against NVDA, through the Ballast UI. They can't.**

The only path available today: the visitor has to leave Ballast, acquire NVDA
somewhere else (Robinhood's own app, or a third-party DEX swap against the real
NVDA/WETH pool), bring it back to their wallet, and only then can they use
Ballast's trade page — which, after this session's earlier work, already
supports paying with NVDA directly for an NVDA-quoted pool. What's missing is
purely the "start from WETH" convenience leg. Step 1 (the multi-hop routing
code) still isn't written — that's unchanged tonight, this session went into
`MAX_QUOTE_ASSETS` instead. **Correction to the RPC framing below**: the
`.env` `RH_RPC_URL_PAID` key (Alchemy) already worked tonight for real forked
contract tests — 10/10 `BallastGraduateFork.t.sol` tests passed against live
mainnet state, including a brand-new one exercising a two-pool graduation
end to end. Alchemy's documented lack of Archive/Debug/Trace support for this
chain (§RPC provider spec) turned out not to matter for plain `forge test
--fork-url`/`anvil --fork-url` state access — only for deep historical reads
and `debug_traceTransaction`, neither of which a fork test needs. So the
step-2 proof script, once step 1 exists, can likely run against the
**already-configured Alchemy key, tonight, at no additional cost** — don't
buy QuickNode on my earlier say-so alone; try the existing key against
`ProveMultiHopSwap.s.sol` first once it's written.

**Mitigation available with zero new code, if steps 1–2 slip:** a creator can
choose WETH as their SECOND quote asset *alongside* a stock — confirmed from
code above, this is "both," not "instead of." A token launched against WETH
and NVDA gets a direct WETH-quoted pool too, and the buy-side problem
disappears for that token specifically. The cost is real, not free: at
`MAX_QUOTE_ASSETS = 2` the tradeoff is now simple and bounded rather than the
open-ended fragmentation risk this section originally flagged — exactly one
choice, take half the depth in each pool to also get direct WETH reach, or
keep full depth in one pool and require the buy-side fix (step 1) instead.
The create flow now shows this tradeoff explicitly the moment a second quote
asset is selected (not left implicit): "Each quote asset gets its own pool.
Your supply is split evenly between them — two pools means half the depth in
each."

---

## §RPC provider spec — the exact thing blocking step 2

Verified tonight directly against each provider's own site (not an SEO
roundup — those are noisy and unreliable for this), 2026-09-23.

**UPDATE, same night, after actually testing:** the reasoning below (Alchemy
lacks Archive/Debug/Trace for this chain, so use QuickNode) is accurate as
written, but I initially over-applied it. A `RH_RPC_URL_PAID` Alchemy key was
already sitting in `.env`, and it ran 10/10 real `forge test --fork-url`
fork tests against live mainnet state without issue tonight — Archive/Debug/
Trace matter for deep historical reads and `debug_traceTransaction`, not for
the standard state access a fork test or `anvil --fork-url` actually needs.
The recommendation to buy QuickNode was made for the multi-hop routing proof
specifically (step 2) on the assumption that a "won't-evict-recent-state"
guarantee was needed — that's plausible for a longer, more complex proof
script, but isn't confirmed necessary the way I stated it. Try the existing
Alchemy key against `ProveMultiHopSwap.s.sol` first, once it exists, before
spending the $49/month.

**Buy: QuickNode, Robinhood Chain (chain ID 4663) mainnet, Build plan, $49/month.**

- QuickNode's own Robinhood Chain page states explicit support: "full archive
  nodes for Robinhood Chain mainnet and testnet with no pruning, plus the
  Debug API," 17+ regions, 99.99% uptime SLA.
- Pricing page confirms Build ($49/mo, 80M API credits, 50 req/s) is the
  cheapest tier with archive data AND Trace/Debug enabled — both are
  explicitly gated to Build-and-above, not available on the free trial.
- Setup: quicknode.com → create an endpoint → select "Robinhood" as the
  chain, mainnet → copy the HTTPS URL into `RH_RPC_URL_PAID` (already a
  documented env var in `.env.example`, unused until now).

**Why not Alchemy**, despite being the provider `docs/robinhood-chain-research.md`
already flagged as "Robinhood's recommended provider": Alchemy's own Robinhood
Chain page explicitly lists Archive, Debug API, and Trace API as **"not
currently supported"** for this chain — a chain-level gap, not something a
higher tier buys you. Alchemy is still a fine choice later for ordinary
production app traffic (their free tier alone is 30M CU/month), but it is the
wrong pick for the specific job blocking tonight (a local `anvil --fork-url`
proof, which needs a node that won't evict recent state mid-session — exactly
what QuickNode explicitly guarantees and Alchemy explicitly does not for this
chain).

**dRPC** also lists Robinhood Chain support but its public pages don't state
archive/debug support explicitly either way, and independent-operator
networks like dRPC are less predictable for state retention consistency
than a single vertically-integrated provider — not recommended for this
specific need, though worth a look for cheap general-purpose reads later.

---

## What's explicitly NOT in this plan

- Batch-2 assets AVGO, HOOD, NFLX, MCD — permanently blocked until Chainlink
  publishes a feed for them on this chain. Nothing either of us can do about
  it tonight or any night until that changes upstream.
- Promoting AMBER quote assets (TSLA, GOOGL, AAPL, META, QQQ, MSFT) to GREEN —
  `docs/exit-liquidity-table.md` explicitly says these need a real
  Quoter-simulated re-review before promotion, not a rubber stamp. Not
  scheduled here; a separate decision when someone does that review.
