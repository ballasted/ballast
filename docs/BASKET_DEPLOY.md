# Stock Basket — deploy & verify

`BasketZap` is immutable and ownerless — all five constructor addresses are
fixed, verified mainnet addresses, nothing to configure via env
(`contracts/script/DeployBasketZap.s.sol`).

**Before deploying, re-read `docs/BASKET_DISCOVERY.md` §2 and
`docs/DECISIONS.md` §3**: as of this build, no on-chain WETH pool exists for
any of the 16 AssetRegistry-listed assets, so deploying doesn't make the
Stock Basket feature usable on real mainnet yet — a swap would simply revert
with nowhere to route. Deploying is safe regardless (the contract holds no
funds and has no admin surface), but keep `NEXT_PUBLIC_BASKET_ENABLED` off and
`web/lib/basketRoutes.ts` empty until a real route is sourced and verified.

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

Expected output (confirmed against real mainnet state, 2026-10-12 — the
`zap:`/`BasketZap deployed:` address shown here is illustrative only, computed
from forge's own default dry-run sender; the REAL deployed address depends on
`basket-deployer`'s actual address + nonce, see (d)):

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
Estimated total gas used for script: 2088789
Estimated amount required: ~0.000084 ETH
==========================

SIMULATION COMPLETE. To broadcast these transactions, add --broadcast and wallet configuration(s) to the previous command.
```

### d. Broadcast

```bash
forge script script/DeployBasketZap.s.sol:DeployBasketZap --rpc-url "$RH_RPC_URL_PAID" \
  --account basket-deployer --sender <addr-from-step-a> --broadcast
```

Note the deployed address from the script's `BasketZap deployed: 0x...` log
line.

### e. Verify

```bash
# Sourcify
forge verify-contract <BASKET_ZAP_ADDRESS> src/BasketZap.sol:BasketZap \
  --verifier sourcify --chain-id 4663 --rpc-url "$RH_RPC_URL_PAID" --guess-constructor-args

# Blockscout
forge verify-contract <BASKET_ZAP_ADDRESS> src/BasketZap.sol:BasketZap \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --chain-id 4663 --rpc-url "$RH_RPC_URL_PAID" --guess-constructor-args
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
has at least one real, human-verified route** (fee/tickSpacing/hooks of an
actual initialized WETH pool, confirmed via `StateView.getSlot0`/`V4Quoter`,
impact ≤3% at 0.1 ETH vs Chainlink — same bar `docs/BASKET_DISCOVERY.md` §2
applied). Both the address and the flag are required (`web/lib/contracts.ts`
`isBasketEnabled`), so a half-configured env never silently turns the section
on — deploying the contract and flipping the flag are deliberately separate
steps.

### g. Post-deploy smoke test

Once a route exists and the flag is flipped:

1. Connect a wallet that is the `creator` of any existing launch (or launch a
   fresh test token).
2. Go to `/app/backing/<that token's address>` → "Add basket".
3. Pick the single routable asset, weight 100%, a small amount (e.g. 0.01
   ETH), default 1% slippage.
4. Confirm the swap. Expect: one signature for the swap, then one
   approve + one deposit confirmation for that asset (docs/DECISIONS.md §1 —
   this is irreducible, not a bug).
5. **Expected result:** the creator's wallet briefly holds the swapped asset,
   then it lands in the treasury; `amountsOut[0]` from the `BasketSwapped`
   event should be a small nonzero amount of that asset.
6. **Where to see it:** reload `/app/backing/<token address>` — the Basket
   card's history section should show the new entry (weight, asset, current
   value via the real `BackingLens` read), and the page's "Verified backing"
   panel total should have increased by that swap's USD value.
