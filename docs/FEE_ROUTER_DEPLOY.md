# FeeRouterFactory — deploy runbook (DEPLOYED — LIVE IN PRODUCTION)

Status: **DEPLOYED & live in production** on Robinhood Chain (4663), wired into
production ballasted.fun.

| | |
|---|---|
| FeeRouterFactory | `0x939536F25b72ca261076Fa485D2A0EE647e54818` |
| Deploy tx | `0x7fe1507d9fd0d8abd79797306d4ee66049aa8fa90bf8394de568293e715dfaa3` |
| Block | `88155554` |
| Deployer | `0xD316888628c75A87e15A15DE36821Fe7371f0cBf` (keystore `feerouter-deployer`) |
| BasketZap (ctor arg) | `0x87c046aB0fB8B7B86BA1a62A956242d499051aBA` |
| Frontend | `NEXT_PUBLIC_FEE_ROUTER_FACTORY_ADDRESS` set on Production + Preview; `NEXT_PUBLIC_FEE_CONFIG_ADDRESS` removed (no longer read); deployed from main `3753652` |
| Blockscout verify | Run the `forge verify-contract` command below (Blockscout reachability from this environment is intermittent — confirm "Verified" in the explorer). |

Matches the predicted address from the dry-run exactly (CREATE from the
deployer's nonce 0). The draft runbook below is retained for reference.

---

## FeeRouterFactory **v2** (DEPLOYED — LIVE IN PRODUCTION)

v2 is a brand-new factory alongside v1 (v1 untouched). It adds: an initial split
**active from block one** (set in `createAndLaunch`, no 7-day wait for the launch
split); an **asymmetric** `scheduleSplit` delay (instant when the change only
lowers the creator share, 7-day for anything else); and a 5th **parent-burn**
bucket for token families (buys an immutable Ballast-launched `parent` through its
WETH pool and sends it to `0x…dEaD`). No owner/admin/upgrade/pause; `realCreator`
immutable.

| | |
|---|---|
| FeeRouterFactoryV2 | `0x5d3250C7ac29648cB54dEbBB89DaD6e733eec5D3` |
| Deploy tx | `0xbff35d90fcdcd0b41dae0fe63e3afdc544e0d91de897035685a21a89bad33b08` |
| Block | `91756428` |
| Deployer | `0xD316888628c75A87e15A15DE36821Fe7371f0cBf` (keystore `feerouter-deployer`, nonce 1) |
| BasketZap (ctor arg) | `0x87c046aB0fB8B7B86BA1a62A956242d499051aBA` |
| Verification | **Sourcify `exact_match`** (Blockscout CLI verify is Cloudflare-gated on this chain; Blockscout auto-imports the Sourcify match). First instance `FeeRouterV2` `0x74dB6b4C2cdF7b04b61099F7c3fC7F9b4B87d92C` + its `HolderStakingVault` `0x57180a0EC9f53b7b819d6b220Be17B4645918AD2` also Sourcify `exact_match`. |
| Frontend | `NEXT_PUBLIC_FEE_ROUTER_FACTORY_V2_ADDRESS` set on Production + Preview; unset ⇒ new launches fall back to v1. |
| Tests | 65 unit + 8 mainnet-fork (all pass, incl. parent-burn end-to-end + deferred-then-flush). |

Matches the dry-run's predicted address exactly (CREATE from the deployer's nonce
1). Deploy script: `contracts/script/DeployFeeRouterFactoryV2.s.sol`.
Verify (Sourcify):

```
cd contracts
forge verify-contract 0x5d3250C7ac29648cB54dEbBB89DaD6e733eec5D3 \
  src/FeeRouterFactoryV2.sol:FeeRouterFactoryV2 \
  --verifier sourcify --chain-id 4663 \
  --constructor-args $(cast abi-encode "constructor(address)" 0x87c046aB0fB8B7B86BA1a62A956242d499051aBA) --watch
```

Kill switch (same shape as v1): `vercel env rm NEXT_PUBLIC_FEE_ROUTER_FACTORY_V2_ADDRESS production --yes`
then redeploy production — new launches revert to v1, existing v2 routers still work on-chain.

---

## What

`FeeRouterFactory` deploys one immutable `FeeRouter` per token (fixed four-bucket
creator-fee splitter: creator / treasury / buyback-&-burn / holder rewards, plus
`runBasket` for one-tx stock baskets on router-launched tokens). No owner, no
admin, no upgrade, no pause.

- Deploy script: `contracts/script/DeployFeeRouterFactory.s.sol`
- Constructor arg (immutable, baked into the script): **BasketZap**
  `0x87c046aB0fB8B7B86BA1a62A956242d499051aBA` — every FeeRouter it deploys is
  wired to this for `runBasket`.
- Deployer keystore: **`feerouter-deployer`** = `0xD316888628c75A87e15A15DE36821Fe7371f0cBf`
  (brand-new keystore, never the old compromised deployer).

## Predicted address

`FeeRouterFactory` → **`0x939536F25b72ca261076Fa485D2A0EE647e54818`**
(CREATE from the deployer's nonce 0 — unchanged by the constructor arg; confirmed
by the dry-run below). Provisional until the funded broadcast confirms.

## Gas / funding (from the dry-run)

- Estimated gas used: **5,769,994**
- Gas price: ~**0.0403 gwei**
- Estimated cost: **~0.000232 ETH**; with a 50% buffer **~0.00035 ETH**.
- The planned funding of **0.001 ETH** (`docs/safe-tx-fund-feerouter-deployer.json`)
  is ~4× the buffered estimate — ample even if gas spikes 10×. Fund the deployer,
  then broadcast.

## Commands (password typed at the interactive prompt — never `--password-file`)

Dry-run (simulate, no broadcast):

```
cd contracts
forge script script/DeployFeeRouterFactory.s.sol:DeployFeeRouterFactory \
  --rpc-url robinhood_mainnet \
  --sender 0xD316888628c75A87e15A15DE36821Fe7371f0cBf
```

Broadcast (after funding the deployer):

```
forge script script/DeployFeeRouterFactory.s.sol:DeployFeeRouterFactory \
  --rpc-url robinhood_mainnet --account feerouter-deployer \
  --sender 0xD316888628c75A87e15A15DE36821Fe7371f0cBf --broadcast
```

Verify:

```
forge verify-contract 0x939536F25b72ca261076Fa485D2A0EE647e54818 \
  src/FeeRouterFactory.sol:FeeRouterFactory --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663
```

## After deploy

Set `NEXT_PUBLIC_FEE_ROUTER_FACTORY_ADDRESS` to the deployed address on Vercel.
That lights up the (basket-aware) fee-router frontend:
- Create page "Fee routing" section.
- Token-page "Where fees go" + staking cards.
- For router-launched tokens: the basket adds via `FeeRouter.runBasket` (one tx),
  treasury withdrawal controls go through the router pass-throughs, and the Ramses
  UI names the human (`realCreator`) as fee recipient. All of this is inert until
  this env var is set.

## Tests

`FeeRouter` suite: **47 passing** (42 unit incl. 7 `runBasket` adversarial tests,
5 fork incl. basket + split-delay). Full repo suite: **379 passing, 0 failed**
(113 fork tests skip without `RH_RPC_URL_PAID`). No gen-1..4 core / FeeConfig /
BasketZap / ProjectTreasury change; no owner/admin/upgrade/pause.

---

## Production smoke test (clean wallet, tiny amounts)

Run on ballasted.fun from a fresh wallet with a little ETH. Each step lists what
you should see. If any step misbehaves, the kill switch below turns the router UI
off without touching EOA launches.

1. **createAndLaunch (router becomes on-chain creator).** `/app/create` → connect
   → fill name/ticker, pair WETH. In **Fee routing**, pick anything other than
   "All to me" (e.g. **Custom** with some Buyback & Stakers — the Treasury bucket
   is "soon"). Launch.
   - Expect: launch succeeds; the token page's **"Where fees go"** card shows your
     split; the token's on-chain `creator` is the new FeeRouter (a
     `FeeRouterCreated` event fired). "All to me" instead would launch a plain
     EOA-creator token with no router — pick a non-default split to get a router.
2. **swaps (generate fees).** On the token page, **Buy** a small amount, then Sell
   a little — each swap pays a 1% fee that accrues to the router.
   - Expect: trades appear; the router is now owed WETH from the hook.
3. **route() (permissionless).** Trigger **Route fees** on the token's fee-routing
   card (or call `route()` on the router).
   - Expect: your creator share arrives as WETH in your wallet; "Tokens burned"
     rises if Buyback > 0; the staking vault is funded if Stakers > 0 and someone
     has staked. Nothing if there were no fees — that's correct.
4. **bucket balances.** Re-read "Where fees go".
   - Expect: Added-to-treasury / Tokens-burned / Rewards-paid totals reflect the
     split; they only ever go up when `route()` runs after real fees.
5. **runBasket (1–2 small legs).** `/app/backing/<token>` → **Add basket** (shown
   to you as the real creator on this gen-4 router launch) → pick 1–2 routable
   stock legs, a small ETH amount, confirm.
   - Expect: **one** signature ("the fee router swaps and deposits atomically");
     the treasury's **creator-withdrawable** balance rises by the swapped amounts;
     leftover ETH refunds to your wallet. Bucket (WETH/burn/rewards) balances are
     untouched.
6. **stake + claim.** Token page **Stake** card → stake some of the token. After a
   `route()` that funds the rewards bucket, **Claim**.
   - Expect: staked balance shows; claimable WETH is > 0 only after a rewards-bucket
     route while you were staked; Claim pays it out. Rewards depend on trading fees
     and can be zero.

## Kill switch

To turn the entire fee-router UI off (e.g. if a problem surfaces):

```
cd web
vercel env rm NEXT_PUBLIC_FEE_ROUTER_FACTORY_ADDRESS production --yes
vercel redeploy <latest-production-deployment-url>
```

With the var gone, `isFeeRouterFactoryConfigured` is false, `useFeeRouter` finds
no router, and every router branch falls back to the plain path: the Create "Fee
routing" section disappears (new launches go straight through BallastFactory,
"All to me"), the token-page fee-router/staking cards hide, and basket / treasury
/ Ramses controls use the EOA-creator path. **EOA launches keep working
unchanged** — they never touched the router.

Caveat: this is a **UI** switch, not a contract switch. Any router-managed launch
created before the kill switch still exists and works on-chain (`route()` /
`runBasket` remain callable directly), but its tailored controls won't render
until the env var is restored — so prefer flipping it back on over leaving a
router launch stranded in the UI.
