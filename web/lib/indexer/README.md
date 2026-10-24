# BALLAST read-only Postgres indexer

A self-contained, additive backend that mirrors on-chain BALLAST activity into
Postgres (Neon) for fast reads (charts, trades, holders, stats). It is **purely a
read accelerator**: every read helper and hook falls back to the app's existing
sources (chain reads / GeckoTerminal / Blockscout) when the DB is unconfigured or
empty, so nothing breaks without it. `next build` passes with every DB env unset.

## Environment

Read **by name only** (never logged). Provisioned on Vercel Prod + Preview (not
local dev):

| Purpose | Var (preferred → fallback) |
| --- | --- |
| Reads (pooled) | `DATABASE_URL` → `POSTGRES_URL` |
| Migrations/writes (unpooled) | `DATABASE_URL_UNPOOLED` → `POSTGRES_URL_NON_POOLING` (→ pooled) |
| Route auth | `CRON_SECRET` (already used by the TG poller) |
| Chain RPC | `RPC_UPSTREAM_URL` (server), else public RPC |
| Cold-backfill genesis (optional) | `INDEXER_START_BLOCK` — set to the first factory deploy block so the initial backfill doesn't start at block 0. Default `0`. |

`isIndexerConfigured()` is true when a pooled read URL exists. Nothing connects at
import time.

## Driver

`@neondatabase/serverless`. `neon()` HTTP client for reads/writes (`db.ts`
`getReadDb()` + `query()`); a `Pool` (routed over fetch via
`neonConfig.poolQueryViaFetch`, so no WebSocket constructor is needed in the Node
serverless runtime) for migrations (`getMigrationDb()`). Hand-written SQL, no ORM.

## Tables (`migrations/0001_init.sql`)

- `launches` — one row per launched token, unioned across all factory generations
  (`FACTORY_ADDRESSES`). PK `token`.
- `pools` — `poolId → token/quote_asset/quote_decimals`, seeded from `PoolSeeded`.
  Resolves which token a `Swap` belongs to. PK `pool_id`.
- `swaps` — individual trades (buy/sell), whole-unit `amount_token`/`amount_quote`,
  `price` (quote per token), `usd_size`. UNIQUE `(tx_hash, log_index)`.
- `ohlc` — candles `1m/5m/1h/4h/1D`, **materialized from `swaps`** (see below).
  PK `(token, bucket, ts)`.
- `balances` — net ERC-20 balance per holder, from `Transfer` events. PK
  `(token, holder)`. Used for holders/distribution.
- `burns` — tokens sent to the dead address (base table for daily burned totals).
- `fee_distributions` — FeeRouter fee-routing outcomes observable as events
  (currently `ParentBurned`; per-leg routed amounts are on-chain totals, not
  events). UNIQUE `(tx, log_index)`.
- `split_events` — FeeRouter split-config changes
  (`scheduled`/`applied`/`applied_instant`). UNIQUE `(tx, log_index)`.
- `buyback_runs` — `BuybackBurnerV2.BuybackBurned`. UNIQUE `(tx, log_index)`.
- `treasury_snapshots` — point-in-time backing valuations (written by the cron via
  `BackingLens`, best-effort).
- `daily_rollups` — per-day `volume_usd/trades/launches/burned_tokens`, recomputed
  from the base tables for touched days. PK `day`.
- `indexer_cursor` — one row per indexing job (`last_block`), so backfill/cron
  resume. Currently one job: `main` (all categories advance together, so the DB is
  never partially-indexed per-category at a given height).
- `schema_migrations` — applied-migration bookkeeping.

### OHLC derivation

OHLC is **derived from `swaps`**, not stored twice from raw data. After a chunk is
indexed, `rollupOhlc` recomputes every **touched bucket completely** by selecting
from the full `swaps` table bounded to the bucket-aligned window — so an
incremental chunk that only contains part of a bucket still produces a correct
candle. Same idea for `daily_rollups`.

### usd_size caveat

`usd_size` is computed for **WETH-quoted** pools as `amount_quote × ETH/USD`, where
ETH/USD is read from the Chainlink feed **at indexing time** (not per historical
block — there is no cheap block-historical feed). It is an approximation for a
volume dashboard, exact for freshly-indexed recent trades. Non-WETH-quoted pools
store `usd_size = NULL`. Never presented as a guaranteed/settled figure.

## Running it

All three privileged routes require `Authorization: Bearer $CRON_SECRET` (or
`x-cron-secret: $CRON_SECRET`) and return 401 otherwise.

1. **Migrate** (idempotent; safe to re-run):

   ```sh
   curl -X POST https://<host>/api/indexer/migrate \
     -H "Authorization: Bearer $CRON_SECRET"
   ```

2. **Backfill** history (chunked, resumable). Call repeatedly until
   `moreWork === false`. `blocks` = blocks per iteration (default 300000, max
   9000000), `iterations` = iterations per invocation (default 1, max 10):

   ```sh
   curl -X POST "https://<host>/api/indexer/backfill?blocks=500000&iterations=5" \
     -H "Authorization: Bearer $CRON_SECRET"
   # → { ok, done, moreWork, fromBlock, toBlock, cursor, head, ranges }
   ```

   Set `INDEXER_START_BLOCK` to the first factory deploy block first, or the cold
   backfill starts at block 0.

3. **Incremental cron** — `/api/cron/index` runs automatically every 2 min
   (`vercel.json`), advancing the cursor to head (bounded 20000 blocks/run) and
   refreshing treasury snapshots once caught up. Vercel Cron sends the
   `CRON_SECRET` Bearer automatically. Manual trigger:

   ```sh
   curl "https://<host>/api/cron/index" -H "Authorization: Bearer $CRON_SECRET"
   ```

## Cursor / resume design

`indexer_cursor.main.last_block` is the highest fully-indexed block. Backfill and
cron both read it, process `[last_block+1, …]` in a bounded window, and advance it
only after the window is persisted. All row inserts use `ON CONFLICT DO NOTHING` on
natural keys (`tx_hash+log_index`, `token`, `pool_id`), so re-running an
overlapping range is safe and never double-counts. Balance upserts apply **net
deltas** per window (`balance = balance + delta`), so they must each run exactly
once per block range — which the single monotonic cursor guarantees.

## Fallback behavior

Read helpers (`queries.ts`) and hooks (`useIndexed*`) return `null` /
`{ available: false }` when the indexer is unconfigured, errors, or has no data for
the request. Pages that adopt these keep their current source whenever
`available === false`, so the indexer is strictly additive.
