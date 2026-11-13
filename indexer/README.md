# Ballast indexer (Ponder)

Multi-chain Ponder indexer. It indexes **two** deployments at once from a single
process:

- **gen-4 Robinhood Chain (4663)** — `src/index.ts`, contracts prefixed `Ballast*` /
  `ProjectToken` / `ProjectTreasuryC` / `PoolManager`.
- **gen-5 Elysium (99901)** — `src/elysiumV5.ts`, contracts suffixed `*V5` /
  `ProtocolFeeVault`. Elysium has **no treasury**; the quote asset is **WHYPE**.

Ponder auto-loads every file under `src/`, so both handler files run together.
All shared tables carry a `chainId` column and gen-5 rows namespace their ids by
chainId (e.g. `99901-<txHash>-<logIndex>`), so the two chains never collide. The
gen-4 handler is unchanged — its inserts omit `chainId`, which defaults to `4663`.

## What the gen-5 handlers index (`src/elysiumV5.ts`)

| Event (contract) | Written to |
| --- | --- |
| `BallastFactoryV5:Launched` | `project` (incl. `feeRouter`, `quoteAsset`, `swapFeeBps`; `treasury`=zero), bumps `protocol` (`global-99901`) launches |
| `BallastFactoryV5:Graduated` | `project.graduated`/`tickLower`/`poolId` (poolId from the event), `pool` (`tokenIsCurrency0` set from WHYPE sort), bumps graduated |
| `ProjectTokenV5:Transfer` | `holder` balances + `project.holderCount` |
| `ProjectTokenV5:MetadataUpdated` | `metadataChange` + `project.metadataURI` |
| `BallastHookV5:FeeTaken` | `feeEvent` (fee, creatorSide, protocol vault, `creatorCut`/`protocolCut`/`quoteAsset`), `project.feesWeth`, `protocol.totalFeesWeth` |
| `BallastHookV5:Claimed` | `feeClaim` (recipient/currency/amount) |
| `BallastHookV5:PoolFeeSet` | `poolFee` (poolId → feeBps) |
| `BallastHookV5:Place` / `Cancel` / `Fill` / `Withdraw` | `limitOrder` lifecycle (see below) |
| `BallastSeederV5:Seeded` | `poolFee` (poolId computed from the emitted key, + token + feeBps) |
| `FeeRouterV5:Routed` / `RoutedToBuyback` / `SplitScheduled` / `SplitApplied` / `SplitAppliedInstant` | `routeEvent` (one row per event, `kind` discriminator) |
| `ProtocolFeeVault:Collected` / `Forwarded` | `vaultSweep` (`kind` = collected/forwarded) |
| `PoolManagerV5:Swap` | `trade` + `candle` (filtered to gen-5 pools via the `pool` table) |

### Pricing / swap orientation
On Elysium the pool token can be **currency0 or currency1** (sorted by address
ascending against WHYPE). `pool.tokenIsCurrency0` is recorded at graduation and used
to orient `priceWeth` (WHYPE-per-token, 1e18) and buy/sell side. For gen-5 rows the
`trade`/`candle` "weth" columns hold the **WHYPE (quote)** leg.

### Limit orders (`limitOrder`)
`Place`/`Cancel`/`Withdraw` carry the owner, so those write per-owner rows keyed
`<chainId>-<epoch>-<owner>` (status `placed` → `cancelled`/`withdrawn`). `Fill` is
emitted at the **epoch** level with no owner, and the indexing store can only look up
by primary key, so a fill writes a **sentinel row** keyed `<chainId>-<epoch>-fill`
(owner = zero, `status = "filled"`) holding the epoch's `token0`/`token1` totals. A UI
joins an owner's row to that sentinel by epoch to compute its pro-rata output.

### Time
Elysium `block.number` is the **parent chain's** block number — never use it for
time. The handlers use `block.timestamp` for all timestamps (block number is stored
only as a bookkeeping field).

## Environment variables (repo-root `.env`, shared with Foundry)

| Var | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection. If unset, Ponder falls back to local PGlite. Reused for both chains. | PGlite |
| `PONDER_RPC_URL_4663` / `RH_RPC_URL_PAID` | gen-4 Robinhood RPC | public RH RPC |
| `PONDER_START_BLOCK` | gen-4 start block | `17514129` |
| `PONDER_RPC_URL_99901` | gen-5 Elysium RPC | `https://rpc.elysium.kinetiq.xyz` (primary) |
| `ELYSIUM_START_BLOCK` | gen-5 start block (factory deploy) | `3085053` |

The **primary** Elysium RPC (`rpc.elysium.kinetiq.xyz`) was unreachable from the dev
sandbox; the working backup is `https://rpc.elyscan.live` (verified `eth_chainId` =
`0x1863d` = 99901, and `eth_getLogs` works with `blockTimestamp`). For local runs set
`PONDER_RPC_URL_99901=https://rpc.elyscan.live`.

## Run

```sh
npm install
npm run codegen     # regenerate ponder-env.d.ts after schema/config changes
npm run typecheck   # tsc --noEmit (strict)
npm run dev         # local dev, terminal UI, PGlite if no DATABASE_URL
npm run start       # production (expects DATABASE_URL = Postgres)
```

Local smoke against the Elysium backup RPC without touching a Postgres DB:

```sh
PONDER_RPC_URL_99901=https://rpc.elyscan.live npm run dev -- --disable-ui
# (set a throwaway DATABASE_URL, or leave it unset to use PGlite)
```

> As of 2026-11-09 the Elysium factory `0x24c9582C…4bEE` is deployed but has **zero**
> `Launched` events yet, so no gen-5 projects/tokens exist to index. The indexer boots
> cleanly and will pick up launches (and their per-launch tokens + FeeRouters via the
> `factory()` pattern) as they happen.
