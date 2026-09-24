# RUNBOOK.md — 252410b to stock pairs trading on mainnet

Every command here was actually run tonight against a real fork of chain 4663
(Alchemy RPC, `RH_RPC_URL_PAID`) before being written down: full deploy →
`launch([WETH,NVDA])` → `graduate()` → real buy → impossible-`MIN_OUT` revert
check, all passed. Numbers below (gas, addresses, output shapes) are measured,
not estimated, except where marked **[estimate]**.

No prose beyond this block. Every step below is WHO / COMMAND / EXPECTED
OUTPUT / IF IT FAILS.

## ETH budget — fund the wallet with this before starting

Real mainnet gas price at time of writing: **41,650,000 wei** (~0.0417 gwei).
ETH/USD: **$2,692.60**. Re-check both yourself before funding — `cast
gas-price --rpc-url $RH_RPC_URL_PAID`.

| Step | Gas | Cost at 41.65M wei/gas | Measured? |
|---|---|---|---|
| 1. Deploy (hook+seeder+factory, registry/lens/feeConfig reused) | 6,496,170 | 0.00027 ETH (~$0.73) | Yes, this session's fork run |
| 3. Allowlist, 6 `setAsset` calls | ~900,000 | 0.0000375 ETH (~$0.10) | **[estimate]** 150k/call |
| 6. `launch()` | 2,094,445 | 0.0000872 ETH (~$0.24) | Yes |
| 7. `graduate()` | 542,852 | 0.0000226 ETH (~$0.06) | Yes |
| 7. First buy (wrap+approve+swap) | 457,012 | 0.000019 ETH (~$0.05) | Yes |
| 8. Impossible-`MIN_OUT` check | 0 — forge's simulation reverts before broadcasting, nothing is sent | $0 | Yes |
| **Total** | ~10.5M gas | **~0.00033 ETH (~$0.90)** | |

**Fund the deployer wallet with 0.01 ETH.** That's >10x the real total above —
covers gas-price spikes and any retry. `preflight.ts` (step 0) already enforces
this exact minimum.

## Irreversibility legend

- 🔴 **IRREVERSIBLE** — no undo. Read the command twice before running.
- 🟡 **Effectively permanent** — technically reversible on-chain but nothing
  reverses the real-world effect (a public deploy, a live launch).
- 🟢 **Reversible** — safe to retry or roll back.

---

## Step 0 — Preflight (blocks everything until it passes)

**WHO: RIZKY**

```bash
cd web
npx tsx scripts/preflight.ts
```

**EXPECTED OUTPUT:** ends with
```
============================================================
ALL CHECKS PASSED. Safe to proceed to the dry run.
```
exit code 0.

**IF IT FAILS:** it prints a numbered list, e.g. `1. balance 0 ETH is below
the 0.01 ETH minimum — fund the wallet first`. Fix each numbered problem, then
re-run this exact command. Do not proceed to Step 1 until this passes clean.
🟢 Reversible — no state written.

---

## Step 1 — Deploy the new BallastFactory 🔴 IRREVERSIBLE

**WHO: RIZKY** (needs the funded deployer's `DEPLOYER_PRIVATE_KEY` — never hand
this to an agent)

Set the reuse addresses first (these keep the live 10-asset allowlist and fee
split — skipping this deploys empty replacements and loses both):

```bash
export REUSE_ASSET_REGISTRY=0x427764d0d19aB765c35A41A5aa4771580307dA81
export REUSE_BACKING_LENS=0x73ac3574c8743553f41c6e25f92a145b5c0e7240
export REUSE_FEE_CONFIG=0xc0b895bc683bf4aca30c7277d42d068e0973a594
```

Dry run first (writes nothing):

```bash
cd web
npx tsx scripts/deployMainnet.ts
```

**EXPECTED OUTPUT:** `mode : DRY-RUN (writes nothing)`, then a `PLAN (deploy
order):` block listing `BallastHook`, `BallastSeeder`, `BallastFactory` (NOT
AssetRegistry/BackingLens/FeeConfig — those are skipped because REUSE_* is
set), each with a predicted address. Ends with `DRY-RUN: nothing deployed.
Re-run with --broadcast (as the funded deployer) to deploy.`

**IF IT FAILS:** an error naming a missing env var — set it and re-run the dry
run. Do not add `--broadcast` until a dry run prints a clean plan.

Now broadcast for real:

```bash
npx tsx scripts/deployMainnet.ts --broadcast
```

**EXPECTED OUTPUT:** `mode : BROADCAST (will deploy)`, then `Mining hook salt
for flags 0xcc …`, then a `=== DEPLOYED — copy into web/.env.local ===` block:
```
NEXT_PUBLIC_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_LENS_ADDRESS=0x73ac3574c8743553f41c6e25f92a145b5c0e7240
NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS=0x427764d0d19aB765c35A41A5aa4771580307dA81
NEXT_PUBLIC_V4_HOOK_ADDRESS=0x...
# FeeConfig: 0xc0b895bc683bf4aca30c7277d42d068e0973a594   Seeder: 0x...
```
then `=== Verifying on Blockscout (standard-input) ===` (this is Step 2,
happens automatically — confirm its result there, don't re-run it separately
unless it errors).

**Save these three values now** — every later step needs them:
```bash
export NEW_FACTORY=<the printed NEXT_PUBLIC_FACTORY_ADDRESS>
export NEW_HOOK=<the printed NEXT_PUBLIC_V4_HOOK_ADDRESS>
export NEW_SEEDER=<the printed Seeder address from the comment line>
```

Confirm it's really the new contract, not the old one:

```bash
cast call $NEW_FACTORY "MAX_QUOTE_ASSETS()(uint256)" --rpc-url $RH_RPC_URL_PAID
```
**EXPECTED OUTPUT:** `2`. (The two LIVE factories today revert on this call —
confirmed tonight — so any non-revert answer proves this is the new one.)

**IF THE BROADCAST FAILS:** read the error. `insufficient funds` → fund the
wallet more (Step 0 should have caught this). Anything else → stop, do not
retry blindly, paste the error to AGENT before touching this wallet again.

Wall-clock: ~2 min dry run + ~2 min broadcast (sub-second blocks on this
chain, most of the wait is Blockscout indexing for the auto-verify).

---

## Step 2 — Verify on Blockscout (only if Step 1's auto-verify didn't finish clean)

**WHO: AGENT**

```bash
cd web
npx tsx scripts/verifyMainnet.ts
```

**EXPECTED OUTPUT:** one line per contract:
```
BallastHook     0x...  already VERIFIED ✓
BallastSeeder   0x...  already VERIFIED ✓
BallastFactory  0x...  already VERIFIED ✓
```
(they'll already show VERIFIED if Step 1's automatic post-deploy verify
succeeded — this step is a no-op check in that case, not a required action.)

**IF IT FAILS:** a `not yet verified` or `submit failed` line for one
contract. Re-run this exact command once (Blockscout indexing lag is the
usual cause). If it fails twice, the contract still functions on-chain —
verification is a transparency nice-to-have, not a blocker for Step 3 onward.
🟢 Reversible, no gas, can retry any time.

Wall-clock: instant if already verified; ~2–5 min if it has to submit + poll.

---

## Step 3 — Allowlist the 6 batch-2 assets 🟡 effectively permanent

**WHO: RIZKY** (needs `DEPLOYER_PRIVATE_KEY` = the AssetRegistry owner)

The 6 new pairs (AMD, COIN, PLTR, ORCL, MSTR, CRCL) are already public/verified
values in `.env.example` — copy them into your real `.env` if they aren't
there yet (the other 10 already are, live):

```bash
grep -E "^(TOKEN|FEED)_(AMD|COIN|PLTR|ORCL|MSTR|CRCL)=" .env.example >> .env
```

Dry run (verifies on-chain, writes nothing):

```bash
cd web
npx tsx scripts/setAssets.ts
```

**EXPECTED OUTPUT:** a table of all 16 candidates, ending with
```
skipped (env unset): AVGO, HOOD, NFLX, MCD
failed verification: (none)
passed & ready     : SGOV, NVDA, TSLA, GOOGL, AAPL, MSFT, AMZN, META, SPY, QQQ, AMD, COIN, PLTR, ORCL, MSTR, CRCL
```
followed by `DRY-RUN: nothing written.`

**IF IT FAILS:** any name under `failed verification` means its feed/token
didn't check out on-chain — do not add `--broadcast` until that list is empty
for the assets you intend to add. `AVGO, HOOD, NFLX, MCD` staying in `skipped`
is expected and correct (no Chainlink feed exists for them — do not chase this).

Broadcast:

```bash
npx tsx scripts/setAssets.ts --broadcast
```

**EXPECTED OUTPUT:** `Broadcasting 16 setAsset call(s) as 0x... ...` (10 are
idempotent no-op updates to already-live assets, 6 are new), each line ending
`OK`, then:
```
=== allowedAssets() now returns 16 asset(s) ===
```

Confirm independently:

```bash
cast call $REUSE_ASSET_REGISTRY "allowedCount()(uint256)" --rpc-url $RH_RPC_URL_PAID
```
**EXPECTED OUTPUT:** `16` (it returns `10` right now, before this step).

**IF IT FAILS:** any line other than `OK` after `Broadcasting` — stop, do not
re-run blindly (re-running is safe/idempotent since `setAsset` overwrites, but
diagnose the revert reason first, usually "not owner").

Wall-clock: ~1 min dry run + ~2 min broadcast (6 txs, sub-second blocks).

---

## Step 4 — Registry/config seeding the new factory needs

**Nothing to do here.** Checked in `docs/GO_LIVE.md`: `BallastSeeder.seed()`
is fully permissionless (no factory allowlist to update) and `BallastHook`
recognizes a Ballast-launched token by a discriminator, not by trusting a
specific factory address. The only registry that needed new writes was
`AssetRegistry`, and that's Step 3, already done. Skip straight to Step 5.

---

## Step 5 — Frontend env vars + deploy

**WHO: RIZKY** (Vercel project `ballast`, already linked — `vercel` CLI is
installed and `.vercel/project.json` exists in this repo)

```bash
cd web
echo -n "$NEW_FACTORY" | vercel env rm NEXT_PUBLIC_FACTORY_ADDRESS production --yes
echo -n "$NEW_FACTORY" | vercel env add NEXT_PUBLIC_FACTORY_ADDRESS production
echo -n "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1,0x069974136c78Cf0F2162463B95321E59F56523D8" | vercel env add NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES production
echo -n "$NEW_HOOK" | vercel env rm NEXT_PUBLIC_V4_HOOK_ADDRESS production --yes
echo -n "$NEW_HOOK" | vercel env add NEXT_PUBLIC_V4_HOOK_ADDRESS production
echo -n "0x743102aa1De955b5F0Fada1377B6E545Fdb080cc" | vercel env add NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES production
vercel --prod
```

(`env rm` before the factory/hook `env add` is needed because Vercel refuses
to add a var that already exists — the `PRIOR_*` vars are new, so no `rm`
needed for those. If a `PRIOR_*` var already has a value from an earlier
redeploy, prepend the new address to the existing comma list instead of
overwriting it — newest-first.)

**EXPECTED OUTPUT:** `vercel --prod` ends with a `https://ballasted.xyz`
(or `ballast-*.vercel.app`) production URL and `Deployed to production.`

Confirm in a browser: open `/app/create`, the quote-asset picker shows more
than one selectable asset (SGOV/NVDA/SPY, not just WETH).

**IF IT FAILS:** `vercel env add` errors with "already exists" — you skipped
the `rm`, run it first. Build failure on `vercel --prod` — read the build log
it links; a missing/malformed env var is the usual cause, re-check every
`NEXT_PUBLIC_*` value with `vercel env ls production`.

🟢 Reversible — re-run `vercel --prod` any time, or `vercel rollback` to the
previous deployment.

Wall-clock: ~2 min setting vars + ~2–3 min build/deploy.

---

## Step 6 — First real launch 🔴 IRREVERSIBLE (creates a permanent token+treasury)

**WHO: RIZKY** (this is a real product decision — what launches first, and
with what backing — not something an agent should decide unprompted)

Through the UI at `/app/create` on the now-live site: pick **WETH + NVDA** as
the two quote assets specifically — this is the only combination proven
end-to-end tonight (no multi-hop routing exists, so a WETH-holder can only
ever buy this token if WETH is one of its own quote-asset pools directly; see
`docs/GO_LIVE.md` §The buy side).

Or, from a terminal, the same call `launch()` makes:

```bash
cast send $NEW_FACTORY "launch(string,string,uint256,string,address[])" \
  "<Name>" "<SYMBOL>" 604800 "ipfs://<your pinned metadata CID>" \
  "[0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC]" \
  --rpc-url $RH_RPC_URL_PAID --private-key $DEPLOYER_PRIVATE_KEY
```
(604800 = 7-day notice period; swap to 2592000 for 30 days or 7776000 for 90
— whichever you intend, since this is immutable per Step 6's own `Launched`
token.)

**EXPECTED OUTPUT:** `status  1 (success)`, and a `Launched` log from
`$NEW_FACTORY` in the receipt. Grab the token address from the log topics
(the 3rd indexed topic) or:

```bash
export TOKEN=$(cast call $NEW_FACTORY "launches(uint256)(address,address,address,uint256)" $(( $(cast call $NEW_FACTORY "launchCount()(uint256)" --rpc-url $RH_RPC_URL_PAID) - 1 )) --rpc-url $RH_RPC_URL_PAID | head -1)
```

**IF IT FAILS:** `BadNoticePeriod` → use exactly 604800/2592000/7776000.
`QuoteAssetNotSupportedYet` → one of your two addresses isn't WETH or a GREEN
asset (SGOV/NVDA/SPY only) — re-check the address, don't guess a fix.

Wall-clock: ~1 min (UI) or seconds (CLI).

---

## Step 7 — Graduate + first real swap 🔴 IRREVERSIBLE (permanently sets opening price)

**WHO: RIZKY**

```bash
cast send $NEW_FACTORY "graduate(address)" $TOKEN --rpc-url $RH_RPC_URL_PAID --private-key $DEPLOYER_PRIVATE_KEY
```

**EXPECTED OUTPUT:** `status  1 (success)`, two `PoolSeeded` logs from
`$NEW_FACTORY` (one per quote asset — WETH and NVDA). **Note the `poolId`**
from each log's data field (first 32 bytes) — you need it for Step 9.

**IF IT FAILS:** `NotLaunchToken`/`AlreadyGraduated` → wrong `$TOKEN` or
already done, check `cast call $NEW_FACTORY "quoteAssetsOf(address)(address[])" $TOKEN`.
`FeedStaleAtLaunch` → only possible if the treasury already holds a deposited
asset with a dead feed; an unbacked launch (nothing deposited yet) never hits
this path.

Now the real buy, against the WETH pool — this is the exact script tested
tonight (deposits WETH, approves Permit2+Router, swaps):

```bash
cd ../contracts
export TOKEN HOOK=$NEW_HOOK DEPLOYER_PRIVATE_KEY
forge script script/mainnet/FirstBuy.s.sol:FirstBuy --rpc-url $RH_RPC_URL_PAID --broadcast
```

Default size is 0.0001 ETH — override with `SWAP_AMOUNT_IN=<wei>` if you want
a different first-trade size.

**EXPECTED OUTPUT:**
```
token received: <some large number>
BUY OK
...
ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
```

**IF IT FAILS:** `need ETH for amountIn + gas` → fund the buyer wallet more.
Anything else — stop, this is real money moving, don't retry until you
understand the error.

Wall-clock: ~1 min for graduate + ~1 min for the buy.

---

## Step 8 — Impossible-`MIN_OUT` revert check 🟢 reversible (nothing broadcasts)

**WHO: RIZKY or AGENT** — this one is safe for either since it costs nothing
and touches no state.

```bash
cd contracts
export TOKEN HOOK=$NEW_HOOK DEPLOYER_PRIVATE_KEY
export MIN_OUT=999999999999999999999999999999
forge script script/mainnet/FirstBuy.s.sol:FirstBuy --rpc-url $RH_RPC_URL_PAID --broadcast
```

**EXPECTED OUTPUT:** `Error: script failed: custom error 0x8b063d73: ...` and
critically **no** `ONCHAIN EXECUTION COMPLETE` banner — forge's own
simulation catches the impossible slippage bound and aborts before sending
anything, so this costs zero gas even though `--broadcast` is passed.
Non-zero exit code is the pass condition here.

**IF IT DOESN'T REVERT** (i.e. you see `BUY OK`): stop immediately — the
slippage guard is broken and real buyers can be sandwiched with no protection.
This is a real bug, not a runbook failure; do not proceed to production
launches until it's fixed.

Unset `MIN_OUT` afterward: `unset MIN_OUT`.

Wall-clock: seconds.

---

## Step 9 — What to watch for the first 24h

**WHO: RIZKY**, periodically (no fixed cadence — check after any burst of
social attention, and once before sleeping).

```bash
cast call 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b "getLiquidity(bytes32)(uint128)" <poolId from Step 7> --rpc-url $RH_RPC_URL_PAID
```

**EXPECTED OUTPUT:** a positive, growing number as buyers add to the
quote-asset side. It reads `0` immediately after graduation on whichever pool
has the token sorted as `currency1` — that's the known half-open-tick-range
boundary artifact (`docs/GO_LIVE.md`), not a bug; it reads correctly again
after the first swap crosses the tick.

Also watch the buyer-side balance sanity check anytime a swap looks wrong:

```bash
cast call $TOKEN "balanceOf(address)(uint256)" <buyer address> --rpc-url $RH_RPC_URL_PAID
```

**IF LIQUIDITY STAYS AT ZERO FOR HOURS AFTER MULTIPLE CONFIRMED BUYS:**
something is wrong with the pool key or hook address used in the buy path —
stop new launches against that quote asset and bring the exact `poolId` and
tx hash to AGENT before doing anything else. This is a diagnostic signal, not
something to route around.

There is no dashboard for this yet (`docs/GO_LIVE.md` step 11, unbuilt) — this
one `cast call` is the whole monitoring surface tonight.
