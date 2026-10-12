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

## 1. Wallet

New keystore, never the compromised old deployer
(`0xA2774e53dCb666799dBA7d00dC11d10d7Ff837D1`):

```bash
cast wallet new ~/.foundry/keystores basketzap-deployer
```

Fund it with a small amount of gas (dry-run below estimates
**~0.000085 ETH** at the time this was written — send 10-20x that, e.g.
0.001 ETH, from the Safe or any funded wallet) before deploying.

## 2. Deploy

Dry run first (no key needed, already run and confirmed this session against
real mainnet state):

```bash
cd contracts
forge script script/DeployBasketZap.s.sol:DeployBasketZap --rpc-url "$RH_RPC_URL_PAID"
```

Then broadcast:

```bash
forge script script/DeployBasketZap.s.sol:DeployBasketZap --rpc-url "$RH_RPC_URL_PAID" \
  --account basketzap-deployer --broadcast
```

Note the deployed address from the script's `BasketZap deployed: 0x...` log
line.

## 3. Verify

```bash
# Sourcify
forge verify-contract <BASKET_ZAP_ADDRESS> src/BasketZap.sol:BasketZap \
  --verifier sourcify --chain-id 4663 --rpc-url "$RH_RPC_URL_PAID" --guess-constructor-args

# Blockscout
forge verify-contract <BASKET_ZAP_ADDRESS> src/BasketZap.sol:BasketZap \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --chain-id 4663 --rpc-url "$RH_RPC_URL_PAID" --guess-constructor-args
```

## 4. Wire up the frontend

```
NEXT_PUBLIC_BASKET_ZAP_ADDRESS=<BASKET_ZAP_ADDRESS>
NEXT_PUBLIC_BASKET_ENABLED=       # leave UNSET/false until a real route exists (see above)
```

Flip `NEXT_PUBLIC_BASKET_ENABLED=true` only once `web/lib/basketRoutes.ts` has
at least one real, human-verified entry (fee/tickSpacing/hooks of an actual
initialized WETH pool for that asset, confirmed via
`StateView.getSlot0`/`V4Quoter`, impact ≤3% at 0.1 ETH vs Chainlink — same bar
`docs/BASKET_DISCOVERY.md` §2 applied). Both the address AND the flag are
required (see `web/lib/contracts.ts`), so a half-configured env never
silently turns the section on.
