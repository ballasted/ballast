import { onchainTable } from "ponder";

// Derived tables the UI reads. Every figure the app shows must reconcile to one of
// these, and each must reconcile to chain state (backing/price are read from the
// chain directly; the indexer only caches counts/history). Holder count == number
// of holder rows with balance > 0; 24h volume == sum of trade rows in the window.

export const project = onchainTable("project", (t) => ({
  id: t.hex().primaryKey(), // token address (the shareable unit)
  treasury: t.hex().notNull(),
  creator: t.hex().notNull(),
  name: t.text(),
  symbol: t.text(),
  metadataURI: t.text(),
  launchMetadataURI: t.text(),
  noticePeriod: t.bigint(),
  launchBlock: t.bigint(),
  launchTimestamp: t.bigint(),
  graduated: t.boolean().notNull(),
  tickLower: t.integer(),
  backingUsd: t.bigint(),
  poolId: t.hex(),
  holderCount: t.integer().notNull(),
  feesWeth: t.bigint().notNull(),
}));

// treasury address -> token, so treasury-event handlers can resolve the project.
export const treasuryLink = onchainTable("treasury_link", (t) => ({
  id: t.hex().primaryKey(), // treasury address
  token: t.hex().notNull(),
}));

// pool id -> token, so PoolManager swaps can be filtered to BALLAST pools.
export const pool = onchainTable("pool", (t) => ({
  id: t.hex().primaryKey(), // poolId
  token: t.hex().notNull(),
}));

export const metadataChange = onchainTable("metadata_change", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  token: t.hex().notNull(),
  oldURI: t.text(),
  newURI: t.text(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

export const holder = onchainTable("holder", (t) => ({
  id: t.text().primaryKey(), // token-address
  token: t.hex().notNull(),
  address: t.hex().notNull(),
  balance: t.bigint().notNull(),
}));

export const trade = onchainTable("trade", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  token: t.hex().notNull(),
  poolId: t.hex().notNull(),
  sender: t.hex().notNull(),
  side: t.text().notNull(), // "buy" | "sell"
  wethAmount: t.bigint().notNull(),
  tokenAmount: t.bigint().notNull(),
  priceWeth: t.bigint().notNull(), // WETH per token, 1e18
  tick: t.integer().notNull(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

export const candle = onchainTable("candle", (t) => ({
  id: t.text().primaryKey(), // token-interval-bucketStart
  token: t.hex().notNull(),
  interval: t.text().notNull(), // 5m|15m|1h|4h|1d
  bucketStart: t.bigint().notNull(),
  open: t.bigint().notNull(),
  high: t.bigint().notNull(),
  low: t.bigint().notNull(),
  close: t.bigint().notNull(),
  volumeWeth: t.bigint().notNull(),
}));

export const treasuryEvent = onchainTable("treasury_event", (t) => ({
  id: t.text().primaryKey(),
  treasury: t.hex().notNull(),
  token: t.hex().notNull(),
  kind: t.text().notNull(), // creator_deposit | deposit_accepted | withdrawal_announced | executed | cancelled
  asset: t.hex().notNull(),
  amount: t.bigint().notNull(),
  party: t.hex().notNull(),
  unlockAt: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

export const feeEvent = onchainTable("fee_event", (t) => ({
  id: t.text().primaryKey(),
  token: t.hex().notNull(),
  feeWeth: t.bigint().notNull(),
  creator: t.hex().notNull(),
  platform: t.hex().notNull(),
  referrer: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

// Protocol-wide running totals — single row "global". Landing-page stats read this,
// and it must equal the sum of what Discover lists (no separate counters).
export const protocol = onchainTable("protocol", (t) => ({
  id: t.text().primaryKey(), // "global"
  launches: t.integer().notNull(),
  graduated: t.integer().notNull(),
  totalFeesWeth: t.bigint().notNull(),
}));
