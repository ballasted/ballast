# BALLAST — Contracts

Foundry workspace for BALLAST's on-chain layer. See `../CLAUDE.md` for the hard
rules and `../docs/BALLAST-build-spec.md` for the full spec.

## Layout

```
src/
  AssetRegistry.sol        Global, owner-managed allowlist. Assets keyed by
                           canonical address only; carries feed + per-asset
                           staleness bound + minimum deposit.
  ProjectTreasury.sol      Per-launch treasury. Immutable notice period,
                           creator-withdrawable vs permanently-locked accounting,
                           third-party deposit queue, two-phase withdrawal.
  BackingLens.sol          Batched read aggregator. Computes locked /
                           withdrawable / total backing per token with full
                           Chainlink staleness + sequencer handling.
  interfaces/
    IAssetRegistry.sol
    AggregatorV3Interface.sol
    IStockToken.sol        ERC-8056 surface (uiMultiplier, oraclePaused, ...).
script/
  DeployCore.s.sol         Deploys AssetRegistry + BackingLens.
test/
  ProjectTreasury.t.sol    29 adversarial-first tests.
  BackingLens.t.sol        14 valuation / oracle tests.
  mocks/                   MockERC20, ReentrantERC20, MockAggregator.
```

## Build & test

```shell
forge build
forge test -vvv
```

## What is intentionally NOT here yet

- **`BallastFactory` + project token + Uniswap v4 pool/hook.** Pool routing depends
  on the *modified* UniversalRouter on this chain (extra `minHopPriceX36` field in
  the v4 swap struct); stock Uniswap SDK calldata reverts, and look-alike routers
  exist. The correct router address and struct encoding must be verified
  independently before this is written. Tracked in the spec's open items.

## Deploy (testnet)

Fill `../.env` (see `../.env.example`), then:

```shell
forge script script/DeployCore.s.sol:DeployCore \
  --rpc-url robinhood_testnet --broadcast \
  --verify --verifier blockscout --chain-id 46630
```

After deploy, the owner allowlists each asset with `setAsset(asset, feed,
staleAfter, minDeposit)` — sourcing addresses from the on-chain asset registry and
the Chainlink Robinhood feeds page, never hardcoded from docs.
