# TONIGHT_RUNBOOK.md — $BALLAST v2 launch, 2026-09-26

Decisions locked in before this runbook:
- **Pair: NVDA + WETH.** PLTR fails the NVDA/SPY depth bar (`docs/phase2-combination-design.md` §3 —
  PLTR's direct WETH pool is $67.9K/thin; real depth is only via USDG). Never WETH-only.
- **Override, explicit:** all four stock feeds (NVDA/SPY/PLTR/SGOV) are resting on Friday's close —
  today is Saturday. `graduate()` will not revert (96h outer bound, feeds are 11–19h old), but the
  design doc's own "market hours on a weekday" policy is being knowingly overridden tonight, by your
  decision. The NVDA pool's opening tick will be fixed from a ~15h-stale Friday-close print, not a
  live Monday one.
- **Creator fee recipient = the Safe**, and must equal the caller (`BallastFactory.sol:367` hardcodes
  `creator = msg.sender`; `BallastToken.creator` is immutable). No FeeSplitter v2 / BuybackBurner v2
  needed tonight — deferred to Step 7.
- **Fresh FeeConfig**: 1% fee (unchanged), 80% creator / 20% platform / 0% referrer, owned by the Safe.
  Sum-check and referrer=0 no-revert/no-loss behavior confirmed from `FeeConfig.sol`/`BallastHook.sol`
  source directly — no fork test needed to prove arithmetic.
- Test suite: 188/189 per `docs/phase2-combination-design.md` §11 (the 1 failure is pre-existing/
  unrelated, unmodified by tonight's changes). Re-run tonight to confirm nothing regressed.

---

## Step 0 — Prep

```bash
cd contracts && git pull
forge build
forge test   # expect 188 passed, 1 known-unrelated failure (BallastHookFork.t.sol);
             # if RH_RPC_URL_PAID isn't exported in your shell, fork suites will SKIP
             # instead of running — export it first if you want the real number.
```

Deployer balance + gas:
```bash
cast balance 0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1 --rpc-url $RH_RPC_URL_PAID --ether
cast gas-price --rpc-url $RH_RPC_URL_PAID
```
One script deploys FeeConfig + Hook (CREATE2-mined) + Seeder + Factory + Router in one broadcast —
budget for ~4M gas (factory alone, measured on fork) plus the other four; multiply by the gas price
above and add margin. On this L2 that's historically low single-digit dollars, but don't trust that
number blind — check live.

RPC:
```bash
read -s RH_RPC_URL_PAID   # paste your Alchemy key-bearing URL, hits Enter without echoing
export RH_RPC_URL_PAID
```

Safe: both signer devices ready. ETH in the Safe for gas (launch tx + migration buy later) and ETH in
the deployer wallet (all five contract deploys — deployer pays this, not the Safe).

---

## Step 1 — Deploy (one script, one broadcast)

**No private key anywhere in this script or command — fixed per your review.** The script no longer
reads `DEPLOYER_PRIVATE_KEY` at all; it uses `vm.startBroadcast()` with no argument, and every
`msg.sender` inside it (including the temporary FeeConfig-owner logic) resolves to whatever `--sender`
you pass. You sign with `--account`, nothing else.

```bash
cd contracts
export NEW_FEE_CONFIG_OWNER=0xEFC97e16a24d2434C7138a2634E554a0631aC079   # Safe
export NEW_FEE_CONFIG_VAULT=0xEFC97e16a24d2434C7138a2634E554a0631aC079   # Safe
export POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
export WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
export ASSET_REGISTRY_ADDRESS=0x427764d0d19aB765c35A41A5aa4771580307dA81
export ETH_USD_FEED=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
export UNIVERSAL_ROUTER=0x8876789976dEcBfCbBbe364623C63652db8C0904
export PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3

# dry run FIRST — --sender only, no --account, no --broadcast. Read every printed
# address before doing anything else:
forge script script/DeployCombinationPackage.s.sol:DeployCombinationPackage \
  --rpc-url $RH_RPC_URL_PAID --sender 0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1

# only after reviewing the dry run — --verifier-url is required here; without it
# forge has no Blockscout endpoint to submit to for this chain:
forge script script/DeployCombinationPackage.s.sol:DeployCombinationPackage \
  --rpc-url $RH_RPC_URL_PAID --sender 0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1 \
  --broadcast --verify --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ --chain-id 4663 \
  --account <your-keystore-name>
```

Verification confirmed working on this chain with this exact `--verifier-url`: `docs/gmgn-verification.md`
records real project tokens going from unverified to verified via it. (Blockscout's own *web UI*,
`robinhoodchain.blockscout.com`, sits behind a Cloudflare bot-check that blocks plain curl — that's a
different endpoint from the verifier API forge actually posts to, which is reachable.)

Note: `FEE_CONFIG_ADDRESS` is deliberately left **unset** — the script deploys a fresh one, sets
80/20/0, and transfers ownership to the Safe (pending `acceptOwnership()` — JSON below, ready now).

**Paste me the full console output.** I'll confirm each printed address independently via `cast call`
before you touch anything else — specifically:
```bash
cast call <FeeConfig>  "feeParams()(uint16,uint16,uint16,uint16,address)" --rpc-url $RH_RPC_URL_PAID
cast call <FeeConfig>  "owner()(address)" --rpc-url $RH_RPC_URL_PAID   # still the deployer until the Safe accepts
cast call <Hook>       "seeder()(address)" --rpc-url $RH_RPC_URL_PAID
cast call <Factory>    "MAX_QUOTE_ASSETS()(uint256)" --rpc-url $RH_RPC_URL_PAID   # expect 2
cast call <Factory>    "isGreenQuoteAsset(address)(bool)" 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC --rpc-url $RH_RPC_URL_PAID  # NVDA, expect true
cast call <Router>     "routeCount()(uint256)" --rpc-url $RH_RPC_URL_PAID   # if this getter exists; else skip
```

**Safe action (non-blocking, do whenever convenient tonight):** the Safe calls `acceptOwnership()` on
the new FeeConfig to complete the 2-step transfer. This does NOT block launching — `owner()` only
gates `setParams`/`setPlatformVault`/`setReferrer`; the hook reads `feeParams()` regardless of who
owns it. Safe Transaction Builder JSON, ready now — paste the real FeeConfig address from Step 1's
output into `"to"` before importing:

```json
{
  "version": "1.0",
  "chainId": "4663",
  "createdAt": 0,
  "meta": { "name": "Accept FeeConfig ownership", "txBuilderVersion": "1.16.0" },
  "transactions": [
    {
      "to": "PASTE_NEW_FEECONFIG_ADDRESS_HERE",
      "value": "0",
      "data": "0x79ba5097",
      "contractMethod": null,
      "_comment": "acceptOwnership() — no args, selector 0x79ba5097 (keccak256(\"acceptOwnership()\")), verified against the real hash, not assumed from memory."
    }
  ]
}
```

### graduate() — who calls it, and the real gap between launch and graduate

`BallastFactory.graduate(address token) external` has **no access-control modifier at all** —
confirmed reading the source directly. It's fully permissionless: once a token is registered via
`launch()` and not yet graduated, **anyone** can call `graduate()` on it, not just the creator.

The website's create-flow runner (`useLaunchRunner.ts`) already knows this and treats it as two
separate steps — for tonight's no-treasury launch: `["launch", "graduate"]`, each its **own on-chain
transaction**. From the Safe: that's **2 separate Safe transactions, each needing 2-of-3 owner
signatures** — 2 signature rounds, not 1. (`ResumeLaunchPanel.tsx`'s own comment confirms this
directly: "`graduate()` is permissionless, so any connected wallet can finish it" — that component
exists specifically to let anyone complete a stuck graduation.)

**The real window this opens:** between `launch()` confirming and the Safe's second signature round
actually broadcasting `graduate()`, the token exists but isn't graduated — and since `graduate()` is
permissionless, a third party watching the chain could call it first. This is **not a fund-loss or
theft risk**: `graduate(token)` takes only the token address, every other parameter (quote assets,
supply split) was already fixed at `launch()` time, so a third party calling it produces the *exact
same result* the Safe would have. The only thing lost is control over the precise moment of
graduation — irrelevant tonight since the stock feed is frozen all weekend regardless of who calls it
or exactly when. On a live-market-hours launch this would matter more (price snapshot timing), but
that's not tonight's situation. No contract change proposed for this — flagging it as understood, not
overlooked.

---

## Step 2 — Vercel env

**Pulled directly from the live Vercel project just now (`vercel env pull`), not assumed from docs —
my first draft had this wrong (conflated the gen-1 address with "currently live"):**

| Var | CURRENT real value in Vercel Production | New value tonight |
|---|---|---|
| `NEXT_PUBLIC_FACTORY_ADDRESS` | `0x3eb5532e982931cad40d0416adbd7930a57965ae` (gen 3) | `<new Factory>` |
| `NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES` | `0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1,0x069974136c78Cf0F2162463B95321E59F56523D8` (gen 2, gen 1) | `0x3eb5532e982931cad40d0416adbd7930a57965ae,0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1,0x069974136c78Cf0F2162463B95321E59F56523D8` — prepend today's outgoing gen 3, keep both existing priors |
| `NEXT_PUBLIC_V4_HOOK_ADDRESS` | `0x4915f612c89100bEbE9279355fab27022D0940cc` (gen 3) | `<new Hook>` |
| `NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES` | `0x743102aa1De955b5F0Fada1377B6E545Fdb080cc,0x9C15c992E4De3711715C8B7D717EF46e474680CC` (gen 2, gen 1) | `0x4915f612c89100bEbE9279355fab27022D0940cc,0x743102aa1De955b5F0Fada1377B6E545Fdb080cc,0x9C15c992E4De3711715C8B7D717EF46e474680CC` — prepend today's outgoing gen 3 hook |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | *(doesn't exist yet)* | `<new Router>` — new var |
| `NEXT_PUBLIC_FEE_CONFIG_ADDRESS` | `[[Sensitive — value hidden from `env ls`, currently one of the two pre-existing instances]]` | `<new FeeConfig>` |

All rows: Production. Keep the "current" column pasted somewhere before overwriting — that's the
exact rollback state if tonight needs to be reverted.

Redeploy: `vercel --prod` (or trigger from the dashboard). After it's live, check `/app/create`'s pool
pairing picker shows NVDA as selectable and `HISTORICAL_HOOKS`/factory union didn't drop any old
generation (spot-check one BALLAST v1 / HARUNA / BALLCAT token page still resolves its pool).

---

## Step 3 — Test launch (before touching $BALLAST v2)

Through the site, Safe via WalletConnect: create a throwaway token, symbol `TEST`, quote assets
**`[WETH, NVDA]`** — deliberately mirroring the real launch's exact path, not just WETH-only, since
this hook/seeder/factory generation has never run end-to-end before. Tiny description is fine.

- 2 Safe signatures to launch, confirm `Launched` event.
- `graduate()` — confirm 2 `PoolSeeded` events, both pools' `slot0` via `StateView` land within one
  tick of the 1-ETH-FDV target (see `docs/phase2-combination-design.md` §1's tolerance note).
- Tiny buy + sell on the WETH pool, tiny buy on the NVDA pool. `BallastRouter.buyWithETH(NVDA, 0, ...)`
  for a fresh NVDA-quoted pool is **confirmed working, not "if wired"**: I wrote and ran a new fork
  test (`test_buyWithETH_intoNvdaQuotedPool`, `contracts/test/BallastRouterFork.t.sol`) proving the
  exact path — ETH → WETH → curated NVDA/WETH pool → NVDA-quoted Ballast pool, end-to-end, real
  mainnet fork, `[PASS]`, router ends with zero dust in every token. Full file: 8/8 pass.
- Check the token page, chips, explorer verification.

I verify all of the above from chain reads as you go — paste tx hashes.

---

## Step 4 — GO / NO-GO

| Item | Status |
|---|---|
| Contracts deployed + verified | pending your Step 1 |
| FeeConfig split = 80/20/0, owner = Safe (pending accept) | pending |
| Test launch (WETH+NVDA) graduates, trades both sides | pending |
| Vercel env updated, old generations still resolve | pending |
| NVDA/ETH-USD feeds still within 96h outer bound at T | recheck at 12:55 UTC (see Step 5) |
| Known weekend-price-gap risk | **accepted by your explicit override** |

GO only if every row above is PASS. If any contract-level row fails: NO-GO, tell me immediately, no
silent workaround.

---

## Step 5 — Launch $BALLAST v2 (target 13:00 UTC)

Feed recheck at 12:55 UTC (same batch call pattern I used for tonight's check, against the new feeds
if different — NVDA is unchanged: `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`):
```bash
cast call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC_URL_PAID
cast call 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9 "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC_URL_PAID
```
Expect `updatedAt` unchanged from tonight's check (markets closed) — that's expected, not a failure,
given your override.

Create-flow inputs: name `Ballast`, symbol `BALLAST`, logo `docs/assets-brand/icon-dark-512.png` (or
`lockup-horizontal.png` if the flow wants a wide asset — check the picker), description: "The Ballast
protocol's own token — relaunched on the multi-quote-asset generation, paired with NVDA and WETH.",
quote assets **`[NVDA, WETH]`**, notice period: n/a (no treasury tonight — skip the deposit step
entirely, per your "treasury: none tonight"). **2 separate Safe transactions** (`launch` then
`graduate`, per the create-flow runner), **2-of-3 signatures each** — 4 individual signature actions
total, not 2. See Step 1's `graduate()` note for why these are separate and what the gap between them
means (harmless tonight).

Copy the new token CA from the `Launched` event. I verify: token, both pools seeded, both at 1 ETH FDV
within tolerance, liquidity locked (via `StateView`/seeder), `creator()` == the Safe.

---

## Step 6 — Right after launch

1. **Migration buy** — Safe Transaction Builder JSON below, fill `AMOUNT_ETH_PLACEHOLDER` and
   `MIN_OUT_PLACEHOLDER` once you decide the migration budget (see Step 7 — the budget-coverage
   report is queued, not done tonight, so pick a number you're comfortable with for now; nothing
   forces you to use it immediately, it can sit in the Safe as planned).
2. **v1→v2 switch — built and done.** `NEXT_PUBLIC_PINNED_TOKEN_ADDRESS` (defaults to v1, so nothing
   broke before tonight) and `NEXT_PUBLIC_PRIOR_PINNED_TOKEN_ADDRESSES` now drive
   `ProtocolTokenNotice.tsx` (the v1 "relaunched" banner + v2 link) and `ProjectCard.tsx`'s
   `v1 · migrated` pill. `npx tsc --noEmit` clean. Set both vars on Vercel once the v2 CA exists:
   `NEXT_PUBLIC_PINNED_TOKEN_ADDRESS=<v2 CA>`, `NEXT_PUBLIC_PRIOR_PINNED_TOKEN_ADDRESSES=0x069a260370c61d91bd3e9842d81d378f9750f7f3`.
   Known gap, not fixed tonight: `CommandSearch.tsx` and `TopMovers.tsx` have no equivalent slot to
   show the "v1 · migrated" label — Discover's grid (where it matters most) has it.
3. **v2 page fee-truth copy** (your exact framing): *"Creator share goes to the Safe
   (`0xEFC97e16a24d2434C7138a2634E554a0631aC079`). The 20% buyback-and-burn is manual until
   FeeSplitter ships — there is no on-chain mechanism enforcing it yet."* Do not show a fee-split chip
   implying the 20% is automated tonight — it isn't.
4. Explorer verification of the v2 token, if not automatic from `--verify` above.
5. External updates (you, not me): X bio, Telegram pin, Fomo, GMGN, gg.xyz, Codex (pending listing),
   DexScreener token info — all with the new CA once minted.

```json
{
  "version": "1.0",
  "chainId": "4663",
  "createdAt": 0,
  "meta": { "name": "Ballast v2 migration buy", "txBuilderVersion": "1.16.0" },
  "transactions": [
    {
      "to": "0x8876789976dEcBfCbBbe364623C63652db8C0904",
      "value": "AMOUNT_ETH_PLACEHOLDER_IN_WEI",
      "data": null,
      "contractMethod": null,
      "_comment": "Placeholder target is the UniversalRouter. The exact calldata (execute() with the WETH-pool ExactInputSingleParams, minHopPriceX36=0) depends on the final v2 token address, which doesn't exist until Step 5 runs. I'll generate the real calldata immediately after you paste the v2 CA — do not sign this placeholder as-is."
    }
  ]
}
```

---

## Step 7 — after launch, continue without waiting (your instruction)

Per your explicit "continue with section 0 P1 without waiting" — once Step 5's launch is confirmed, I
keep going on this list myself, no need for another prompt: BallastRouter routes for every asset that
passes the depth bar (currently just NVDA+SPY; re-check the rest of the 16 against the same criteria),
all 17 logos (16 stock + WETH/ETH) across create picker / swap selector / pool chips / Discover /
search / Top Movers, and the fee-truth copy from Step 6 item 3 landing everywhere the fee split is
shown, not just the v2 page. I'll report back once that's substantially done rather than going silent.

## Deferred, not tonight (per check 5's resolution + time)

- FeeSplitter v2 / BuybackBurner v2 for $BALLAST v2 — **not needed for tonight's launch** (creator fee
  recipient must equal the caller; Safe is both). Build if/when you want the real 75/25 buyback split
  instead of the manual process Step 6 item 3 describes honestly.
- Migrator + `/migrate` page + snapshot Merkle root — **the balance snapshot and the real 05:00-11:00
  UTC TWAP are done, committed** (`data/snapshot/`, block `73030228`, TWAP `$0.000007100633157926953`
  — the window had zero trades, so TWAP = the last real swap's price, not a spot-price stand-in; full
  methodology in `data/snapshot/README.md`). The Merkle root and Migrator contract are what's still
  queued, plus your migration-budget decision (how much ETH covers what % of snapshot USD value).
- Timelock + ownership transfers (Part A) — independent of tonight, do whenever.
- Security-check tooling (Part D), exact-out estimate — unchanged from before, not urgent tonight.
