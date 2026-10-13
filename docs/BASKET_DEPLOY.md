# Stock Basket — deploy & verify

`BasketZap` is immutable and ownerless. **REWRITE (docs/DECISIONS.md §6):** it
no longer takes a UniversalRouter + Permit2; it now inherits v4-periphery's
`V4Router` and takes the PoolManager plus the fixed Fables/Ramses route tables,
exactly like `BallastRouterV2`. The constructor is
`(factory, registry, IPoolManager, weth, FablesHop[], RamsesRoute[])` — every
value is a fixed, verified mainnet address or the same route table
`DeployBallastRouterV2.s.sol` was deployed with, all baked into
`contracts/script/DeployBasketZap.s.sol` (nothing to configure via env). The
index maps in that script are IDENTICAL to `DeployBallastRouterV2.s.sol`'s, so
you can diff the two deploys line for line.

**Before deploying, re-read `docs/BASKET_DISCOVERY.md`**: real routes now exist
(Fables ETH→USDG→stock and Ramses v3), so a deploy makes the feature usable for
the assets whose routes clear the ≤3%-impact-at-0.1-ETH bar in that doc's route
table. Deploying is safe regardless (the contract holds no funds, has no admin
surface, and a leg with no viable route reverts `AllVenuesFailedForLeg`). Keep
`NEXT_PUBLIC_BASKET_ENABLED` off and `web/lib/basketRoutes.ts` limited to the
human-verified routable set until the frontend route table + hooks are wired to
the new index-based `Leg` shape.

## Rizky's checklist

### a. Wallet

New keystore, never the compromised old deployer
(`0xA2774e53dCb666799dBA7d00dC11d10d7Ff837D1`):

```bash
cast wallet new ~/.foundry/keystores basket-deployer
```

Get its address for the broadcast command below:

```bash
cast wallet address --account basket-deployer
```

### b. Funding

Send **0.001 ETH** (≈12x the dry-run's estimated cost — see (c)) to that
address from the Safe or any funded wallet.

### c. Dry run

No key needed. Re-run this before broadcasting — if the estimate has moved
meaningfully (gas price, or the script itself changed), re-check (b).

```bash
cd contracts
set -a; source ../.env; set +a
forge script script/DeployBasketZap.s.sol:DeployBasketZap --rpc-url "$RH_RPC_URL_PAID"
```

Expected output (confirmed against real mainnet state, 2026-10-13, with the
V4Router-rewrite constructor — the `zap:`/`BasketZap deployed:` address shown
here is illustrative only, computed from forge's own default dry-run sender;
the REAL deployed address depends on `basket-deployer`'s actual address +
nonce, see (d)):

```
Script ran successfully.

== Return ==
zap: contract BasketZap 0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519

== Logs ==
  BasketZap deployed: 0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519

## Setting up 1 EVM.
==========================
Chain 4663
Estimated gas price: ~0.04 gwei
Estimated total gas used for script: 6231310
Estimated amount required: ~0.00025 ETH
==========================

SIMULATION COMPLETE. To broadcast these transactions, add --broadcast and wallet configuration(s) to the previous command.
```

(Gas is ~3x the pre-rewrite figure because the Fables/Ramses route tables are
now baked into the deployed bytecode. 0.001 ETH funding is still ~4x headroom.)

### d. Broadcast

```bash
forge script script/DeployBasketZap.s.sol:DeployBasketZap --rpc-url "$RH_RPC_URL_PAID" \
  --account basket-deployer --sender <addr-from-step-a> --broadcast
```

Note the deployed address from the script's `BasketZap deployed: 0x...` log
line.

### e. Verify

`--guess-constructor-args` reads the trailing constructor args from the on-chain
creation tx, which works for the array args (`FablesHop[]`/`RamsesRoute[]`) too —
it just extracts the bytes after the init code. Try it first:

```bash
# Sourcify
forge verify-contract <BASKET_ZAP_ADDRESS> src/BasketZap.sol:BasketZap \
  --verifier sourcify --chain-id 4663 --rpc-url "$RH_RPC_URL_PAID" --guess-constructor-args

# Blockscout
forge verify-contract <BASKET_ZAP_ADDRESS> src/BasketZap.sol:BasketZap \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --chain-id 4663 --rpc-url "$RH_RPC_URL_PAID" --guess-constructor-args
```

If the guess fails (complex nested-array args occasionally defeat it), pass them
explicitly. The exact bytes are deterministic — the deploy script already ran
them. Grab the encoded args straight from the dry-run broadcast artifact:

```bash
# The constructor-args ABI blob is the tail of the creation input in:
#   contracts/broadcast/DeployBasketZap.s.sol/4663/run-latest.json
# (or dry-run/run-latest.json). Diff it against DeployBallastRouterV2's for a
# sanity check — the fablesHops/ramsesRoutes portions must match byte-for-byte.
forge verify-contract <BASKET_ZAP_ADDRESS> src/BasketZap.sol:BasketZap \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --chain-id 4663 --rpc-url "$RH_RPC_URL_PAID" \
  --constructor-args <0x…encoded-args-from-the-broadcast-artifact>
```

### f. Vercel env vars

Set on **every environment that should be able to show the feature** —
realistically Production only, once a route exists; set on Preview too if you
want to test the full flow on a preview deploy first with `basketRoutes.ts`
temporarily populated on a branch:

```
NEXT_PUBLIC_BASKET_ZAP_ADDRESS=<BASKET_ZAP_ADDRESS>
NEXT_PUBLIC_BASKET_ENABLED=true
```

**Do not set `NEXT_PUBLIC_BASKET_ENABLED=true` until `web/lib/basketRoutes.ts`
marks the human-verified routable set** (the 7 assets that cleared ≤3% impact at
0.1 ETH vs Chainlink on Ramses — SGOV, AAPL, GOOGL, NVDA, SPY, PLTR, CRCL —
per `docs/BASKET_DISCOVERY.md` §2.2) **and the frontend hooks build the new
index-based `Leg` shape** (`asset, weightBps, preferFables, fablesHopIdx,
ramsesHopIdx, minOut`) from `web/lib/routerV2.ts`. Both the address and the flag
are required (`web/lib/contracts.ts` `isBasketEnabled`), so a half-configured env
never silently turns the section on — deploying the contract and flipping the
flag are deliberately separate steps.

### g. Post-deploy smoke test

Once the routable set is wired and the flag is flipped:

1. Connect a wallet that is the `creator` of any existing launch (or launch a
   fresh test token).
2. Go to `/app/backing/<that token's address>` → "Add basket".
3. Pick a routable asset (e.g. NVDA or SPY — the deepest direct-WETH pools),
   weight 100%, a small amount (e.g. 0.01 ETH), default 1% slippage.
4. Confirm the swap. Expect: one signature for the swap, then one
   approve + one deposit confirmation for that asset (docs/DECISIONS.md §1/§7 —
   this is irreducible for a plain-EOA creator, not a bug; a Safe/7702 creator
   can batch all of it into one signature).
5. **Expected result:** the creator's wallet briefly holds the swapped asset,
   then it lands in the treasury; `amountsOut[0]` from the `BasketSwapped`
   event should be a small nonzero amount of that asset.
6. **Where to see it:** reload `/app/backing/<token address>` — the Basket
   card's history section should show the new entry (weight, asset, current
   value via the real `BackingLens` read), and the page's "Verified backing"
   panel total should have increased by that swap's USD value.
