# Elysium gen-5 mainnet runbook

The operator procedure for deploying BALLAST gen-5 to **Elysium mainnet**. Mainnet is a
**pure config swap**: the same scripts that ran on testnet read a different file
(`contracts/deployments/elysium-mainnet.json`). You do not edit Solidity to go live — you
fill a JSON, verify it, and broadcast.

Audience: the human operator (you). Claude Code wrote the contracts, tests, scripts, and
this doc; **you** fill `.env`, verify official addresses, and broadcast — per the division
of labour in `CLAUDE.md`.

> Deploy order, one line: **verify v4 → fill config → simulate → broadcast `DeployElysium`
> → verify flags → hand factory to the Safe → Safe accepts → verify contracts → smoke.**

---

## What gets deployed

Five gen-5 contracts, in this dependency order (the order `DeployElysium.s.sol` uses, and
the order the `Gen5` test suite proves):

1. **BallastHookV5** — CREATE2-mined so its address carries exactly the six v4 permission
   flags (`BALLAST_HOOK_V5_FLAGS`). Singleton; every pool shares it. Skims the swap fee,
   splits it 80% creator-side / 20% protocol, locks the seeder's LP, runs on-chain limit
   orders.
2. **ProtocolFeeVault** — ownerless sink for the protocol 20%. Can only ever forward funds
   to the ONE `protocolBurnDestination` burned in at construction. No admin, no rescue.
3. **BallastSeederV5** — one-sided, permanently-locked LP seeder; also writes each pool's
   creator-picked fee onto the hook once, at seed time.
4. **BallastFactoryV5** — launch entry point + registry. `Ownable2Step`; owner is the Safe
   on mainnet. Per launch it also deploys a **FeeRouterV5** (the token's on-chain creator).
5. *(FeeRouterV5 is deployed per-launch by the factory — not a top-level address.)*

There is **no AssetRegistry contract**: `treasuryEnabled=false` on Elysium (no price feeds
exist), and the green-quote-asset allowlist lives inside the factory (WHYPE only).

---

## Prerequisites (do these BEFORE touching the config)

### 1. Official Uniswap v4 addresses — bytecode-verify every one

Mainnet **must** use the official Uniswap v4 deployment published at Elysium launch. Never
the testnet self-deploy. For each of `poolManager`, `positionManager`, `stateView`,
`v4Quoter`, `universalRouter`:

- Get the address from the official Uniswap v4 deployments list for this chain (not a
  forum post, not a block explorer search for "PoolManager").
- Pull the on-chain bytecode (`cast code <addr> --rpc-url $ELYSIUM_MAINNET_RPC_URL`) and
  confirm it matches the published Uniswap release for the version Elysium ships.
- **If any address does not verify: STOP. Do not deploy.**

> Chain gotcha (carried from Robinhood Chain): multiple look-alike routers exist. Verify
> the UniversalRouter independently. If Elysium ships a *modified* router (extra swap-struct
> fields), the frontend's calldata encoding must match it — flag that before relying on it
> for swaps. The protocol contracts themselves do not call UniversalRouter.

### 2. Infra addresses

Confirm each has code on mainnet: `create2Deployer` (`0x4e59…4956C` — the deterministic
proxy forge routes `new{salt}` through; the hook mine REQUIRES it), `multicall3`,
`permit2`, Safe singleton + proxy factory. Fill them in the config's `infra` block.

### 3. Tokens

`tokens.whype` = canonical WHYPE on Elysium mainnet. Verify `symbol() == "WHYPE"` and
`decimals() == 18`. `tokens.usdc` similarly (not used as a quote asset yet, but recorded).

### 4. The Safe (protocol owner)

Deploy a Safe on Elysium mainnet. Note which Safe version Kinetiq ships. Put its address in
`owner.protocolOwner`. The factory is handed to this Safe via `Ownable2Step`; the Safe must
call `acceptOwnership()` to complete the handover (step 6 below).

### 5. `protocolBurnDestination` — DECIDE THIS (it is immutable)

The ProtocolFeeVault forwards the protocol 20% to exactly one address, fixed forever at
construction. Choosing it is **your** call — see `docs/elysium-burn-design.md`. It must be a
real address before you deploy; the deploy script rejects the testnet placeholder.

### 6. Opening valuation

Default `openingValuationHype = 27 HYPE`, `openingTickWhype = -174300` (spacing-60-aligned,
token-as-currency0 convention; the factory negates it when the token sorts as currency1).
Confirm this is the valuation you want at launch, or recompute the tick off-chain and keep
it a multiple of 60. The deploy script asserts spacing alignment.

### 7. Funded deployer

`DEPLOYER_PRIVATE_KEY` funded with ETH (gas token) on mainnet. `DEPLOYER` = its address;
you pass it as `--sender`.

---

## Fill the config

Edit `contracts/deployments/elysium-mainnet.json`. Every empty string / `chainId: 0` must
be filled from the prerequisites above. The script fails loud if any required field is
missing, mis-typed, or placeholder — but check them yourself first:

- `chainId` — Elysium mainnet id (the script asserts it equals the live chain).
- `infra.*`, `tokens.whype`, `v4.*` — verified addresses from steps 1–3.
- `params.protocolBurnDestination` — step 5. **Immutable after deploy.**
- `owner.protocolOwner` — the Safe, step 4.
- `router.*` — FeeRouterV5 construction params (defaults are fine:
  `maxSlippageBps=2000`, `maxRoutePerCall="0"` meaning unlimited, `routeCooldownSecs=3600`).
- `params.treasuryEnabled` — leave **false** (the factory constructor reverts otherwise).

`deployments/elysium-mainnet.json` must **never** contain any testnet address. The
`isProduction: true` flag in it makes `DeployElysiumV4` refuse to run against it.

---

## Deploy

All commands run from `contracts/`.

### Step 0 — dry run (no broadcast)

```sh
ELYSIUM_CONFIG=deployments/elysium-mainnet.json \
forge script script/DeployElysium.s.sol:DeployElysium \
  --rpc-url $ELYSIUM_MAINNET_RPC_URL --sender $DEPLOYER
```

This parses + validates the config and simulates the full deploy. If it reverts, read the
message — every failure is a plain-English `require` (`"poolManager has no code on this
chain"`, `"protocolBurnDestination unset/placeholder"`, `"config chainId != live
chainId"`, …). Fix the config and re-run until the simulation succeeds and logs a
`DEPLOYED` block.

### Step 1 — broadcast

Add `--broadcast` (and `--verify` if the explorer verifier is wired — see below):

```sh
ELYSIUM_CONFIG=deployments/elysium-mainnet.json \
forge script script/DeployElysium.s.sol:DeployElysium \
  --rpc-url $ELYSIUM_MAINNET_RPC_URL --sender $DEPLOYER --broadcast
```

> `--sender $DEPLOYER` is **required**, not optional: the hook captures `tx.origin` at
> construction and gates its one-time `setSeeder` / `setProtocolVault` on it. Omit it and
> the wiring reverts with `NotDeployer`.

### Step 2 — record addresses

Copy the logged `DEPLOYED (paste into the config's 'ballast' block)` addresses into
`elysium-mainnet.json`'s `ballast` block. The script deliberately does **not** write the
file itself (a simulation run must never clobber real addresses). The canonical record is
also in `broadcast/DeployElysium.s.sol/<chainId>/run-latest.json`.

### Step 3 — verify the hook flags

The script already asserts `address(hook) & 0x3fff == BALLAST_HOOK_V5_FLAGS` and reverts if
the mined address is wrong. Double-check the logged line `hook flags OK`. A hook at a
flag-invalid address is rejected by the PoolManager on the first pool init.

---

## Hand the factory to the Safe

The factory deployed with the deployer as its initial owner, then called
`transferOwnership(Safe)`. Ownership is **pending** until the Safe accepts:

- From the Safe, call `factory.acceptOwnership()`.
- Confirm `factory.owner() == Safe` and `factory.pendingOwner() == address(0)`.

Until the Safe accepts, the deployer still owns the factory. Only the owner can call
`setGreenQuoteAsset` (reserved for when real stock tokens + feeds exist later — leave
unused for now; WHYPE is green from construction).

---

## Verify contracts on the explorer

```sh
forge verify-contract <addr> <Contract> \
  --verifier blockscout --chain-id <ELYSIUM_CHAIN_ID> \
  --verifier-url <ELYSIUM_EXPLORER_API>
```

Verify all four top-level contracts (hook, vault, seeder, factory) plus — after the first
launch — one FeeRouterV5 and one BallastToken instance (so the per-launch bytecode is
publicly verified once). Constructor args must match what the script used; pull them from
`run-latest.json`.

---

## Post-deploy smoke test

On mainnet, do one controlled end-to-end before announcing:

1. `factory.launch(name, symbol, swapFeeBps, metadataURI, WHYPE, 10000, 0, 0)` — a
   creator-100% split. Confirm `Launched` event; note the token + feeRouter.
2. `factory.graduate(token)` — confirm `Graduated`, and that the pool opened at the
   expected tick (`±openingTickWhype` by sort order).
3. A small WHYPE→token buy through the official UniversalRouter. Confirm:
   - `hook.owed(feeRouter, WHYPE)` ≈ 80% of the fee, `hook.owed(vault, WHYPE)` ≈ 20%.
   - `vault.sweep(WHYPE)` forwards the protocol cut to `protocolBurnDestination` and
     nowhere else.
4. (Optional) `FeeRouterV5(feeRouter).wireBuybackPool()` then `route(0,0)` — confirm the
   creator receives their share and the buyback burns token to `0x…dEaD`.

If any step misbehaves, **do not announce**; the contracts are immutable, so a bad
parameter means a fresh deploy with a corrected config.

---

## Testnet rehearsal (do this first, days before mainnet)

Testnet has no published v4, so you self-deploy it (non-production use permitted by v4-core's
BUSL-1.1 — testing only, never mainnet).

```sh
# 1. Self-deploy v4 on testnet
ELYSIUM_CONFIG=deployments/elysium-testnet.json \
forge script script/DeployElysiumV4.s.sol:DeployElysiumV4 \
  --rpc-url $ELYSIUM_TESTNET_RPC_URL --sender $DEPLOYER --broadcast
# -> paste poolManager/stateView/v4Quoter into the config's .v4 block.
#    (positionManager/universalRouter are not needed on testnet: the seeder owns its own
#     LP, and the logged PoolSwapTest drives validation swaps.)

# 2. Point the fork test at the live manager (optional sanity):
export ELYSIUM_POOL_MANAGER=<poolManager>
forge test --match-path "test/elysium/Gen5Fork.t.sol"

# 3. Deploy gen-5 on testnet — identical command to mainnet, different config:
ELYSIUM_CONFIG=deployments/elysium-testnet.json \
forge script script/DeployElysium.s.sol:DeployElysium \
  --rpc-url $ELYSIUM_TESTNET_RPC_URL --sender $DEPLOYER --broadcast
```

Fill `owner.protocolOwner` (testnet EOA ok), `params.protocolBurnDestination` (any testnet
address), and `tokens.whype`/`v4.*` first. Run the full smoke test on testnet. Only once
that passes end-to-end do you repeat against mainnet.

---

## Pre-flight checklist

- [ ] Every `v4.*` address bytecode-verified against official Uniswap v4.
- [ ] `infra.*`, `tokens.whype` have code on mainnet; WHYPE is 18-dec, symbol "WHYPE".
- [ ] `protocolBurnDestination` decided and is a real address (burn-design doc signed off).
- [ ] `owner.protocolOwner` = the mainnet Safe (version noted).
- [ ] `treasuryEnabled: false`; `openingTickWhype` multiple of 60; `chainId` correct.
- [ ] Deployer funded; `--sender $DEPLOYER` in the command.
- [ ] Testnet rehearsal passed end-to-end (launch + graduate + swap + vault sweep).
- [ ] Dry run (no `--broadcast`) succeeds and logs a `DEPLOYED` block.
- [ ] After broadcast: hook-flags line OK; addresses recorded; contracts verified.
- [ ] Safe called `acceptOwnership()`; `factory.owner() == Safe`.
- [ ] Mainnet smoke test passed before any announcement.
