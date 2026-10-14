# FeeRouterFactory — deploy runbook (DRAFT — NOT DEPLOYED)

Status: **NOT DEPLOYED.** This is the draft runbook; nothing has been broadcast.

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
