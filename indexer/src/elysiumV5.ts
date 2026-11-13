import { ponder } from "ponder:registry";
import * as schema from "ponder:schema";
import { encodeAbiParameters, keccak256, type Hex, type Address } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// Gen-5 Elysium (chain 99901) handlers. Wholly separate from gen-4 (src/index.ts):
// distinct contract names, distinct topic0, and every id is NAMESPACED by chainId
// so Elysium rows can never collide with Robinhood rows in a shared table.
//
// Elysium note: block.number is the PARENT chain's block — NEVER use it for time.
// Use block.timestamp. (block.number is still stored as a bookkeeping field only.)
// ─────────────────────────────────────────────────────────────────────────────

const CHAIN_ID = 99901;
const PROTOCOL_ID = "global-99901";
const ZERO = "0x0000000000000000000000000000000000000000" as const;

// Gen-5 pool identity. Quote asset is WHYPE; the token can be currency0 OR currency1
// (sorted by address ascending). fee is 0 (dynamic fee lives on the hook), spacing 60.
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81";
const HOOK = "0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc";
const TICK_SPACING = 60;

const POOL_KEY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

function poolIdFromKey(currency0: Address, currency1: Address): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI, [
      { currency0, currency1, fee: 0, tickSpacing: TICK_SPACING, hooks: HOOK as Address },
    ]),
  );
}

// Gen-5 pool ordering: WHYPE + hook, both orderings (token may sort either side).
// poolId itself comes straight from the Graduated/Seeded events (no recompute), so we
// only need which side the token sorts to, for price/side orientation in swaps.
function tokenIsCurrency0(token: Address): boolean {
  return token.toLowerCase() < WHYPE.toLowerCase();
}

// Quote(WHYPE)-per-token, 1e18-scaled, from sqrtPriceX96.
// sqrtPriceX96^2 / 2^192 = currency1 per currency0.
function priceQuotePerToken(sqrtPriceX96: bigint, tokenIsC0: boolean): bigint {
  const sq = sqrtPriceX96 * sqrtPriceX96;
  if (sq === 0n) return 0n;
  if (tokenIsC0) {
    // quote is currency1: currency1/currency0 = sq / 2^192
    return (sq * 10n ** 18n) >> 192n;
  }
  // quote is currency0: currency0/currency1 = 2^192 / sq
  return (10n ** 18n << 192n) / sq;
}

const INTERVALS = [
  ["5m", 300n],
  ["15m", 900n],
  ["1h", 3600n],
  ["4h", 14400n],
  ["1d", 86400n],
] as const;

// deno-lint-ignore no-explicit-any
type Ctx = { db: any };

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// Elysium protocol-totals row (global-99901). Mirrors gen-4 bumpProtocol but targets
// the per-chain row.
async function bumpProtocol(
  context: Ctx,
  d: { launches?: number; graduated?: number; fees?: bigint },
) {
  await context.db
    .insert(schema.protocol)
    .values({
      id: PROTOCOL_ID,
      chainId: CHAIN_ID,
      launches: d.launches ?? 0,
      graduated: d.graduated ?? 0,
      totalFeesWeth: d.fees ?? 0n,
    })
    .onConflictDoUpdate((r: typeof schema.protocol.$inferSelect) => ({
      launches: r.launches + (d.launches ?? 0),
      graduated: r.graduated + (d.graduated ?? 0),
      totalFeesWeth: r.totalFeesWeth + (d.fees ?? 0n),
    }));
}

async function incHolderCount(context: Ctx, token: Hex, delta: number) {
  const p = await context.db.find(schema.project, { id: token });
  if (p) await context.db.update(schema.project, { id: token }).set({ holderCount: p.holderCount + delta });
}

async function adjustHolder(context: Ctx, token: Hex, addr: Hex, delta: bigint) {
  if (addr === ZERO) return; // mints/burns don't create a holder row or count
  const id = `${CHAIN_ID}-${token}-${addr}`;
  const existing = await context.db.find(schema.holder, { id });
  if (!existing) {
    await context.db
      .insert(schema.holder)
      .values({ id, chainId: CHAIN_ID, token, address: addr, balance: delta });
    if (delta > 0n) await incHolderCount(context, token, 1);
    return;
  }
  const next = existing.balance + delta;
  await context.db.update(schema.holder, { id }).set({ balance: next });
  if (existing.balance <= 0n && next > 0n) await incHolderCount(context, token, 1);
  else if (existing.balance > 0n && next <= 0n) await incHolderCount(context, token, -1);
}

async function upsertCandle(
  context: Ctx,
  token: Hex,
  label: string,
  secs: bigint,
  ts: bigint,
  price: bigint,
  vol: bigint,
) {
  const bucket = (ts / secs) * secs;
  const id = `${CHAIN_ID}-${token}-${label}-${bucket}`;
  await context.db
    .insert(schema.candle)
    .values({
      id,
      chainId: CHAIN_ID,
      token,
      interval: label,
      bucketStart: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volumeWeth: vol,
    })
    .onConflictDoUpdate((r: typeof schema.candle.$inferSelect) => ({
      high: price > r.high ? price : r.high,
      low: price < r.low ? price : r.low,
      close: price,
      volumeWeth: r.volumeWeth + vol,
    }));
}

// ── Factory ──────────────────────────────────────────────────────────────────
ponder.on("BallastFactoryV5:Launched", async ({ event, context }) => {
  const token = event.args.token;
  await context.db
    .insert(schema.project)
    .values({
      id: token,
      chainId: CHAIN_ID,
      treasury: ZERO, // gen-5 has NO treasury
      creator: event.args.creator,
      metadataURI: event.args.metadataURI,
      launchMetadataURI: event.args.metadataURI,
      launchBlock: event.block.number,
      launchTimestamp: event.block.timestamp,
      graduated: false,
      holderCount: 0,
      feesWeth: 0n,
      feeRouter: event.args.feeRouter,
      quoteAsset: event.args.quoteAsset,
      swapFeeBps: event.args.swapFeeBps,
    })
    .onConflictDoNothing();
  await bumpProtocol(context, { launches: 1 });
});

ponder.on("BallastFactoryV5:Graduated", async ({ event, context }) => {
  const token = event.args.token;
  const poolId = event.args.poolId; // emitted directly — no recompute needed
  await context.db
    .update(schema.project, { id: token })
    .set({ graduated: true, tickLower: event.args.openTick, poolId });
  await context.db
    .insert(schema.pool)
    .values({ id: poolId, chainId: CHAIN_ID, token, tokenIsCurrency0: tokenIsCurrency0(token) })
    .onConflictDoNothing();
  await bumpProtocol(context, { graduated: 1 });
});

// ── Token (factory child) ────────────────────────────────────────────────────
ponder.on("ProjectTokenV5:Transfer", async ({ event, context }) => {
  const token = event.log.address;
  if (event.args.value === 0n) return;
  await adjustHolder(context, token, event.args.from, -event.args.value);
  await adjustHolder(context, token, event.args.to, event.args.value);
});

ponder.on("ProjectTokenV5:MetadataUpdated", async ({ event, context }) => {
  const token = event.log.address;
  await context.db.insert(schema.metadataChange).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    token,
    oldURI: event.args.oldURI,
    newURI: event.args.newURI,
    timestamp: event.args.timestamp,
    block: event.block.number,
  });
  await context.db.update(schema.project, { id: token }).set({ metadataURI: event.args.newURI });
});

// ── Hook: fees ─────────────────────────────────────────────────────────────────
ponder.on("BallastHookV5:FeeTaken", async ({ event, context }) => {
  await context.db.insert(schema.feeEvent).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    token: event.args.token,
    feeWeth: event.args.fee,
    creator: event.args.creatorSide,
    platform: event.args.protocol,
    referrer: ZERO, // no referrer bucket in gen-5
    quoteAsset: event.args.quoteAsset,
    creatorCut: event.args.creatorCut,
    protocolCut: event.args.protocolCut,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
  await bumpProtocol(context, { fees: event.args.fee });
  const p = await context.db.find(schema.project, { id: event.args.token });
  if (p) {
    await context.db
      .update(schema.project, { id: event.args.token })
      .set({ feesWeth: p.feesWeth + event.args.fee });
  }
});

ponder.on("BallastHookV5:Claimed", async ({ event, context }) => {
  await context.db.insert(schema.feeClaim).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    recipient: event.args.recipient,
    currency: event.args.currency,
    amount: event.args.amount,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

ponder.on("BallastHookV5:PoolFeeSet", async ({ event, context }) => {
  await context.db
    .insert(schema.poolFee)
    .values({
      id: event.args.poolId,
      chainId: CHAIN_ID,
      poolId: event.args.poolId,
      feeBps: event.args.feeBps,
      timestamp: event.block.timestamp,
      block: event.block.number,
    })
    .onConflictDoUpdate(() => ({ feeBps: event.args.feeBps }));
});

// ── Hook: limit-order lifecycle ────────────────────────────────────────────────
ponder.on("BallastHookV5:Place", async ({ event, context }) => {
  const id = `${CHAIN_ID}-${event.args.epoch}-${event.args.owner}`;
  await context.db
    .insert(schema.limitOrder)
    .values({
      id,
      chainId: CHAIN_ID,
      epoch: event.args.epoch,
      owner: event.args.owner,
      poolId: event.args.poolId,
      tickLower: event.args.tickLower,
      zeroForOne: event.args.zeroForOne,
      liquidity: event.args.liquidity,
      status: "placed",
      placedAt: event.block.timestamp,
      updatedAt: event.block.timestamp,
      block: event.block.number,
    })
    .onConflictDoUpdate((r: typeof schema.limitOrder.$inferSelect) => ({
      liquidity: r.liquidity + event.args.liquidity,
      status: "placed",
      updatedAt: event.block.timestamp,
    }));
});

ponder.on("BallastHookV5:Cancel", async ({ event, context }) => {
  const id = `${CHAIN_ID}-${event.args.epoch}-${event.args.owner}`;
  await context.db
    .insert(schema.limitOrder)
    .values({
      id,
      chainId: CHAIN_ID,
      epoch: event.args.epoch,
      owner: event.args.owner,
      poolId: event.args.poolId,
      tickLower: 0,
      zeroForOne: false,
      liquidity: event.args.liquidity,
      status: "cancelled",
      placedAt: null,
      updatedAt: event.block.timestamp,
      block: event.block.number,
    })
    .onConflictDoUpdate(() => ({ status: "cancelled", updatedAt: event.block.timestamp }));
});

// Fill is epoch-level (no owner). Record a sentinel row (owner = zero) holding the
// epoch's token0/token1 totals; owner rows join to it by epoch for pro-rata output.
ponder.on("BallastHookV5:Fill", async ({ event, context }) => {
  const id = `${CHAIN_ID}-${event.args.epoch}-fill`;
  await context.db
    .insert(schema.limitOrder)
    .values({
      id,
      chainId: CHAIN_ID,
      epoch: event.args.epoch,
      owner: ZERO,
      poolId: event.args.poolId,
      tickLower: event.args.tickLower,
      zeroForOne: event.args.zeroForOne,
      liquidity: 0n,
      status: "filled",
      token0: event.args.token0,
      token1: event.args.token1,
      placedAt: null,
      updatedAt: event.block.timestamp,
      block: event.block.number,
    })
    .onConflictDoUpdate(() => ({
      status: "filled",
      token0: event.args.token0,
      token1: event.args.token1,
      updatedAt: event.block.timestamp,
    }));
});

ponder.on("BallastHookV5:Withdraw", async ({ event, context }) => {
  const id = `${CHAIN_ID}-${event.args.epoch}-${event.args.owner}`;
  await context.db
    .insert(schema.limitOrder)
    .values({
      id,
      chainId: CHAIN_ID,
      epoch: event.args.epoch,
      owner: event.args.owner,
      poolId: ("0x" + "00".repeat(32)) as Hex,
      tickLower: 0,
      zeroForOne: false,
      liquidity: 0n,
      status: "withdrawn",
      token0: event.args.amount0,
      token1: event.args.amount1,
      placedAt: null,
      updatedAt: event.block.timestamp,
      block: event.block.number,
    })
    .onConflictDoUpdate(() => ({
      status: "withdrawn",
      token0: event.args.amount0,
      token1: event.args.amount1,
      updatedAt: event.block.timestamp,
    }));
});

// ── Seeder: records the per-pool creator fee at seed time ──────────────────────
ponder.on("BallastSeederV5:Seeded", async ({ event, context }) => {
  const key = event.args.key;
  const poolId = poolIdFromKey(key.currency0, key.currency1);
  await context.db
    .insert(schema.poolFee)
    .values({
      id: poolId,
      chainId: CHAIN_ID,
      poolId,
      feeBps: event.args.feeBps,
      token: event.args.token,
      timestamp: event.block.timestamp,
      block: event.block.number,
    })
    .onConflictDoUpdate(() => ({ feeBps: event.args.feeBps, token: event.args.token }));
});

// ── FeeRouterV5 (per-launch): routes + split changes ───────────────────────────
ponder.on("FeeRouterV5:Routed", async ({ event, context }) => {
  await context.db.insert(schema.routeEvent).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    feeRouter: event.log.address,
    kind: "routed",
    caller: event.args.caller,
    total: event.args.total,
    toCreator: event.args.toCreator,
    toBuyback: event.args.toBuyback,
    toRewards: event.args.toRewards,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

ponder.on("FeeRouterV5:RoutedToBuyback", async ({ event, context }) => {
  await context.db.insert(schema.routeEvent).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    feeRouter: event.log.address,
    kind: "buyback",
    whypeIn: event.args.whypeIn,
    tokenBought: event.args.tokenBought,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

ponder.on("FeeRouterV5:SplitScheduled", async ({ event, context }) => {
  await context.db.insert(schema.routeEvent).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    feeRouter: event.log.address,
    kind: "split_scheduled",
    creatorBps: event.args.creatorBps,
    buybackBps: event.args.buybackBps,
    rewardsBps: event.args.rewardsBps,
    effectiveAt: event.args.effectiveAt,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

ponder.on("FeeRouterV5:SplitApplied", async ({ event, context }) => {
  await context.db.insert(schema.routeEvent).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    feeRouter: event.log.address,
    kind: "split_applied",
    creatorBps: event.args.creatorBps,
    buybackBps: event.args.buybackBps,
    rewardsBps: event.args.rewardsBps,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

ponder.on("FeeRouterV5:SplitAppliedInstant", async ({ event, context }) => {
  await context.db.insert(schema.routeEvent).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    feeRouter: event.log.address,
    kind: "split_instant",
    creatorBps: event.args.creatorBps,
    buybackBps: event.args.buybackBps,
    rewardsBps: event.args.rewardsBps,
    cancelledPending: event.args.cancelledPending,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

// ── ProtocolFeeVault: sweeps ───────────────────────────────────────────────────
ponder.on("ProtocolFeeVault:Collected", async ({ event, context }) => {
  await context.db.insert(schema.vaultSweep).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    currency: event.args.currency,
    amount: event.args.amount,
    kind: "collected",
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

ponder.on("ProtocolFeeVault:Forwarded", async ({ event, context }) => {
  await context.db.insert(schema.vaultSweep).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    currency: event.args.currency,
    amount: event.args.amount,
    destination: event.args.destination,
    kind: "forwarded",
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
});

// ── Pool swaps (singleton PoolManager, filtered to gen-5 pools) ────────────────
ponder.on("PoolManagerV5:Swap", async ({ event, context }) => {
  const poolRow = await context.db.find(schema.pool, { id: event.args.id });
  if (!poolRow) return; // not one of ours

  const token = poolRow.token as Hex;
  const tokenIsC0 = poolRow.tokenIsCurrency0 as boolean;

  const tokenLeg = tokenIsC0 ? event.args.amount0 : event.args.amount1;
  const quoteLeg = tokenIsC0 ? event.args.amount1 : event.args.amount0;
  const tokenAmount = abs(tokenLeg);
  const quoteAmount = abs(quoteLeg);
  // Pool sends token out (token leg < 0) => a buy; sends token in => a sell.
  const side = tokenLeg < 0n ? "buy" : "sell";
  const priceWeth = priceQuotePerToken(event.args.sqrtPriceX96, tokenIsC0);

  await context.db.insert(schema.trade).values({
    id: `${CHAIN_ID}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId: CHAIN_ID,
    token,
    poolId: event.args.id,
    sender: event.args.sender,
    side,
    wethAmount: quoteAmount, // WHYPE (quote) leg
    tokenAmount,
    priceWeth, // WHYPE per token, 1e18
    tick: event.args.tick,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });

  for (const [label, secs] of INTERVALS) {
    await upsertCandle(context, token, label, secs, event.block.timestamp, priceWeth, quoteAmount);
  }
});
