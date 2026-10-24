-- 0001_init — BALLAST read-only indexer schema.
--
-- Canonical, human-readable mirror of the statements run by
-- web/app/api/indexer/migrate/route.ts. The route executes the identical
-- statements from ./index.ts (embedded there so they are always present in the
-- Vercel function bundle — a .sql file is not guaranteed to be traced into a
-- serverless function). Keep this file and index.ts in sync.
--
-- Everything is idempotent (IF NOT EXISTS) so re-running migrate is safe.
-- All numeric on-chain amounts are stored in WHOLE units (already divided by the
-- token/quote decimals) as NUMERIC, so reads never have to know decimals.

-- Applied-migration bookkeeping.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per indexing job so backfill/incremental can resume independently.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  name       TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Launched tokens, unioned across every factory generation.
CREATE TABLE IF NOT EXISTS launches (
  token        TEXT PRIMARY KEY,
  treasury     TEXT NOT NULL,
  creator      TEXT NOT NULL,
  factory      TEXT NOT NULL,
  launch_id    BIGINT,
  launch_block BIGINT NOT NULL,
  launch_ts    TIMESTAMPTZ NOT NULL,
  name         TEXT,
  symbol       TEXT,
  metadata_uri TEXT
);
CREATE INDEX IF NOT EXISTS launches_creator_idx ON launches (creator);
CREATE INDEX IF NOT EXISTS launches_ts_idx ON launches (launch_ts);

-- poolId -> token/quote mapping, seeded from PoolSeeded events. swaps join here.
CREATE TABLE IF NOT EXISTS pools (
  pool_id        TEXT PRIMARY KEY,
  token          TEXT NOT NULL,
  quote_asset    TEXT NOT NULL,
  quote_decimals INT  NOT NULL DEFAULT 18,
  open_tick      INT,
  block          BIGINT,
  ts             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pools_token_idx ON pools (token);

-- Individual trades. amount_token / amount_quote are whole units; price is
-- quote-per-token (whole units); usd_size is the USD value of the trade for
-- WETH-quoted pools (NULL for non-WETH quotes — see README).
CREATE TABLE IF NOT EXISTS swaps (
  id           BIGSERIAL PRIMARY KEY,
  pool_id      TEXT NOT NULL,
  token        TEXT NOT NULL,
  quote_asset  TEXT NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('buy','sell')),
  amount_token NUMERIC NOT NULL,
  amount_quote NUMERIC NOT NULL,
  price        NUMERIC,
  usd_size     NUMERIC,
  trader       TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  block_ts     TIMESTAMPTZ NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INT NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS swaps_token_ts_idx ON swaps (token, block_ts);
CREATE INDEX IF NOT EXISTS swaps_pool_idx ON swaps (pool_id);
CREATE INDEX IF NOT EXISTS swaps_ts_idx ON swaps (block_ts);

-- OHLC candles, materialized from swaps by the indexer (recompute-touched-bucket,
-- see lib/indexer/chain.ts). Derivable from swaps; kept as a table so reads are cheap.
CREATE TABLE IF NOT EXISTS ohlc (
  token      TEXT NOT NULL,
  bucket     TEXT NOT NULL CHECK (bucket IN ('1m','5m','1h','4h','1D')),
  ts         TIMESTAMPTZ NOT NULL,
  open       NUMERIC NOT NULL,
  high       NUMERIC NOT NULL,
  low        NUMERIC NOT NULL,
  close      NUMERIC NOT NULL,
  volume_usd NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (token, bucket, ts)
);

-- Net ERC-20 balances per holder, accumulated from Transfer events.
CREATE TABLE IF NOT EXISTS balances (
  token      TEXT NOT NULL,
  holder     TEXT NOT NULL,
  balance    NUMERIC NOT NULL DEFAULT 0,
  last_block BIGINT NOT NULL,
  PRIMARY KEY (token, holder)
);
CREATE INDEX IF NOT EXISTS balances_token_idx ON balances (token);

-- Tokens sent to the dead address (burns). Base table for daily burned totals.
CREATE TABLE IF NOT EXISTS burns (
  id        BIGSERIAL PRIMARY KEY,
  token     TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  amount    NUMERIC NOT NULL,
  block     BIGINT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  tx        TEXT NOT NULL,
  log_index INT NOT NULL,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS burns_token_ts_idx ON burns (token, ts);

-- FeeRouter family: observed fee-routing outcomes (currently ParentBurned —
-- per-leg routed amounts are on-chain totals, not events; see README).
CREATE TABLE IF NOT EXISTS fee_distributions (
  id        BIGSERIAL PRIMARY KEY,
  token     TEXT,
  router    TEXT,
  recipient TEXT,
  amount    NUMERIC NOT NULL,
  kind      TEXT NOT NULL,
  block     BIGINT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  tx        TEXT NOT NULL,
  log_index INT NOT NULL,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS fee_distributions_token_idx ON fee_distributions (token);

-- FeeRouter split-config change events.
CREATE TABLE IF NOT EXISTS split_events (
  id             BIGSERIAL PRIMARY KEY,
  router         TEXT NOT NULL,
  token          TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('scheduled','applied','applied_instant')),
  creator_bps    INT,
  treasury_bps   INT,
  buyback_bps    INT,
  parent_burn_bps INT,
  rewards_bps    INT,
  effective_at   TIMESTAMPTZ,
  block          BIGINT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL,
  tx             TEXT NOT NULL,
  log_index      INT NOT NULL,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS split_events_router_idx ON split_events (router);

-- Protocol buyback-and-burn runs (BuybackBurnerV2.BuybackBurned).
CREATE TABLE IF NOT EXISTS buyback_runs (
  id           BIGSERIAL PRIMARY KEY,
  burner       TEXT NOT NULL,
  asset        TEXT,
  amount_in    NUMERIC NOT NULL,
  amount_burned NUMERIC NOT NULL,
  total_burned NUMERIC,
  block        BIGINT NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  tx           TEXT NOT NULL,
  log_index    INT NOT NULL,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS buyback_runs_ts_idx ON buyback_runs (ts);

-- Point-in-time treasury valuations (written by the cron via BackingLens).
CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  treasury         TEXT NOT NULL,
  token            TEXT,
  total_value_usd  NUMERIC,
  locked_value_usd NUMERIC,
  block            BIGINT NOT NULL,
  ts               TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS treasury_snapshots_treasury_ts_idx ON treasury_snapshots (treasury, ts);

-- Per-day protocol rollups, recomputed from the base tables for touched days.
CREATE TABLE IF NOT EXISTS daily_rollups (
  day           DATE PRIMARY KEY,
  volume_usd    NUMERIC NOT NULL DEFAULT 0,
  trades        INT NOT NULL DEFAULT 0,
  launches      INT NOT NULL DEFAULT 0,
  burned_tokens NUMERIC NOT NULL DEFAULT 0
);
