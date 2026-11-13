import { onchainTable } from "ponder";

// Derived tables the UI reads. Every figure the app shows must reconcile to one of
// these, and each must reconcile to chain state (backing/price are read from the
// chain directly; the indexer only caches counts/history). Holder count == number
// of holder rows with balance > 0; 24h volume == sum of trade rows in the window.

// NOTE on multi-chain: gen-4 rows (Robinhood, 4663) are written UNCHANGED by
// src/index.ts — they omit `chainId`, so the `.default(4663)` fills it. Gen-5 rows
// (Elysium, 99901) are written by src/elysiumV5.ts, which sets chainId: 99901 and
// NAMESPACES every id by chainId (e.g. `99901-<txHash>-<logIndex>`), so Elysium rows
// can never collide with Robinhood rows in a shared table.
export const project = onchainTable("project", (t) => ({
  id: t.hex().primaryKey(), // token address (the shareable unit); gen-5 keeps bare addr (unique per chain in practice)
  chainId: t.integer().notNull().default(4663),
  treasury: t.hex().notNull(), // gen-5 has NO treasury -> zero address
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
  // ── gen-5 (Elysium) additions ──
  feeRouter: t.hex(), // per-launch FeeRouterV5
  quoteAsset: t.hex(), // WHYPE on Elysium
  swapFeeBps: t.integer(), // creator-picked swap fee, fixed at launch
}));

// treasury address -> token, so treasury-event handlers can resolve the project.
export const treasuryLink = onchainTable("treasury_link", (t) => ({
  id: t.hex().primaryKey(), // treasury address
  token: t.hex().notNull(),
}));

// pool id -> token, so PoolManager swaps can be filtered to BALLAST pools.
export const pool = onchainTable("pool", (t) => ({
  id: t.hex().primaryKey(), // poolId (globally unique bytes32)
  token: t.hex().notNull(),
  chainId: t.integer().notNull().default(4663),
  // gen-5: WHYPE pools can have the token as currency0 OR currency1 (sorted by
  // address ascending). Needed to orient price/side in the swap handler. Gen-4
  // tokens are always currency0 (mined below WETH), so this stays true there.
  tokenIsCurrency0: t.boolean().notNull().default(true),
}));

export const metadataChange = onchainTable("metadata_change", (t) => ({
  id: t.text().primaryKey(), // (chainId-)txHash-logIndex
  chainId: t.integer().notNull().default(4663),
  token: t.hex().notNull(),
  oldURI: t.text(),
  newURI: t.text(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

export const holder = onchainTable("holder", (t) => ({
  id: t.text().primaryKey(), // token-address (gen-5: chainId-token-address)
  chainId: t.integer().notNull().default(4663),
  token: t.hex().notNull(),
  address: t.hex().notNull(),
  balance: t.bigint().notNull(),
}));

// For gen-5 (Elysium) the "weth" columns hold the QUOTE leg (WHYPE): wethAmount is
// the WHYPE amount, priceWeth is WHYPE-per-token (1e18). Columns reused to keep the
// gen-4 table working unchanged; disambiguate by chainId.
export const trade = onchainTable("trade", (t) => ({
  id: t.text().primaryKey(), // (chainId-)txHash-logIndex
  chainId: t.integer().notNull().default(4663),
  token: t.hex().notNull(),
  poolId: t.hex().notNull(),
  sender: t.hex().notNull(),
  side: t.text().notNull(), // "buy" | "sell"
  wethAmount: t.bigint().notNull(), // gen-5: WHYPE (quote) amount
  tokenAmount: t.bigint().notNull(),
  priceWeth: t.bigint().notNull(), // quote per token, 1e18 (gen-5: WHYPE per token)
  tick: t.integer().notNull(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

export const candle = onchainTable("candle", (t) => ({
  id: t.text().primaryKey(), // token-interval-bucketStart (gen-5: chainId-token-...)
  chainId: t.integer().notNull().default(4663),
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
  chainId: t.integer().notNull().default(4663),
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

// Gen-5 FeeTaken maps here: feeWeth=fee, creator=creatorSide (the FeeRouterV5),
// platform=protocol vault, referrer=zero (no referrer bucket in gen-5). The gen-5
// extras (quoteAsset, creatorCut, protocolCut) are nullable additions.
export const feeEvent = onchainTable("fee_event", (t) => ({
  id: t.text().primaryKey(),
  chainId: t.integer().notNull().default(4663),
  token: t.hex().notNull(),
  feeWeth: t.bigint().notNull(), // gen-5: total fee in the quote asset (WHYPE)
  creator: t.hex().notNull(), // gen-5: creatorSide (FeeRouterV5)
  platform: t.hex().notNull(), // gen-5: protocol vault
  referrer: t.hex().notNull(), // gen-5: zero (no referrer bucket)
  // ── gen-5 additions ──
  quoteAsset: t.hex(),
  creatorCut: t.bigint(),
  protocolCut: t.bigint(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

// Protocol-wide running totals — one row PER CHAIN. gen-4 uses id "global"; gen-5
// uses id "global-99901". Landing-page stats read the row for their chain.
export const protocol = onchainTable("protocol", (t) => ({
  id: t.text().primaryKey(), // "global" (gen-4) | "global-99901" (gen-5)
  chainId: t.integer().notNull().default(4663),
  launches: t.integer().notNull(),
  graduated: t.integer().notNull(),
  totalFeesWeth: t.bigint().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Gen-5 (Elysium) — new tables. All namespaced by chainId.
// ─────────────────────────────────────────────────────────────────────────────

// On-chain range-order limit orders (BallastHookV5). Place/Cancel/Withdraw are
// per-OWNER (owner in the event), so those rows are keyed `chainId-epoch-owner`.
// Fill is emitted at the EPOCH level (no owner) and the DB store can only look up by
// primary key, so a Fill writes a sentinel row keyed `chainId-epoch-fill`
// (owner = zero, status = "filled") holding the epoch's token0/token1 totals; the UI
// joins an owner's row to that sentinel by epoch to compute its pro-rata share.
export const limitOrder = onchainTable("limit_order", (t) => ({
  id: t.text().primaryKey(), // chainId-epoch-owner | chainId-epoch-fill
  chainId: t.integer().notNull().default(99901),
  epoch: t.bigint().notNull(),
  owner: t.hex().notNull(), // zero on the fill sentinel row
  poolId: t.hex().notNull(),
  tickLower: t.integer().notNull(),
  zeroForOne: t.boolean().notNull(),
  liquidity: t.bigint().notNull(), // this owner's liquidity (0 on sentinel)
  status: t.text().notNull(), // placed | filled | cancelled | withdrawn
  token0: t.bigint().notNull().default(0n), // epoch fill totals (sentinel) / owner withdraw amount0
  token1: t.bigint().notNull().default(0n),
  placedAt: t.bigint(),
  updatedAt: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

// Hook fee claims (BallastHookV5 Claimed): recipient pulled `amount` of `currency`.
export const feeClaim = onchainTable("fee_claim", (t) => ({
  id: t.text().primaryKey(), // chainId-txHash-logIndex
  chainId: t.integer().notNull().default(99901),
  recipient: t.hex().notNull(),
  currency: t.hex().notNull(),
  amount: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

// FeeRouterV5 events: Routed / RoutedToBuyback / Split{Scheduled,Applied,Instant}.
export const routeEvent = onchainTable("route_event", (t) => ({
  id: t.text().primaryKey(), // chainId-txHash-logIndex
  chainId: t.integer().notNull().default(99901),
  feeRouter: t.hex().notNull(),
  kind: t.text().notNull(), // routed | buyback | split_scheduled | split_applied | split_instant
  caller: t.hex(),
  total: t.bigint(),
  toCreator: t.bigint(),
  toBuyback: t.bigint(),
  toRewards: t.bigint(),
  whypeIn: t.bigint(),
  tokenBought: t.bigint(),
  creatorBps: t.integer(),
  buybackBps: t.integer(),
  rewardsBps: t.integer(),
  effectiveAt: t.bigint(),
  cancelledPending: t.boolean(),
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

// ProtocolFeeVault sweeps: Collected (from hook) / Forwarded (to destination).
export const vaultSweep = onchainTable("vault_sweep", (t) => ({
  id: t.text().primaryKey(), // chainId-txHash-logIndex
  chainId: t.integer().notNull().default(99901),
  currency: t.hex().notNull(),
  amount: t.bigint().notNull(),
  destination: t.hex(), // set on forwarded only
  kind: t.text().notNull(), // collected | forwarded
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));

// Per-pool creator swap fee (BallastHookV5 PoolFeeSet + BallastSeederV5 Seeded).
export const poolFee = onchainTable("pool_fee", (t) => ({
  id: t.hex().primaryKey(), // poolId (globally unique bytes32)
  chainId: t.integer().notNull().default(99901),
  poolId: t.hex().notNull(),
  feeBps: t.integer().notNull(),
  token: t.hex(), // known from Seeded
  timestamp: t.bigint().notNull(),
  block: t.bigint().notNull(),
}));
