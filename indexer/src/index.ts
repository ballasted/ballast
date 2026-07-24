import { ponder } from "ponder:registry";
import * as schema from "ponder:schema";
import { encodeAbiParameters, keccak256, type Hex, type Address } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

// Pool identity — mirrors web/lib/pool.ts exactly. A BALLAST pool is token/WETH,
// token mined below WETH (currency0), fee 0, tickSpacing 60, singleton hook.
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const HOOK = "0x9C15c992E4De3711715C8B7D717EF46e474680CC";
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

function computePoolId(token: Address): Hex {
  const [c0, c1] =
    token.toLowerCase() < WETH.toLowerCase()
      ? [token, WETH as Address]
      : [WETH as Address, token];
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI, [
      { currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: HOOK as Address },
    ]),
  );
}

// Spot price of the token in WETH, 1e18-scaled, from sqrtPriceX96 (token is
// currency0, WETH currency1, so the ratio is WETH-per-token directly).
function priceFromSqrtX96(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
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

async function bumpProtocol(context: Ctx, d: { launches?: number; graduated?: number; fees?: bigint }) {
  await context.db
    .insert(schema.protocol)
    .values({
      id: "global",
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
  const id = `${token}-${addr}`;
  const existing = await context.db.find(schema.holder, { id });
  if (!existing) {
    await context.db.insert(schema.holder).values({ id, token, address: addr, balance: delta });
    if (delta > 0n) await incHolderCount(context, token, 1);
    return;
  }
  const next = existing.balance + delta;
  await context.db.update(schema.holder, { id }).set({ balance: next });
  if (existing.balance <= 0n && next > 0n) await incHolderCount(context, token, 1);
  else if (existing.balance > 0n && next <= 0n) await incHolderCount(context, token, -1);
}

async function upsertCandle(context: Ctx, token: Hex, label: string, secs: bigint, ts: bigint, price: bigint, vol: bigint) {
  const bucket = (ts / secs) * secs;
  const id = `${token}-${label}-${bucket}`;
  await context.db
    .insert(schema.candle)
    .values({ id, token, interval: label, bucketStart: bucket, open: price, high: price, low: price, close: price, volumeWeth: vol })
    .onConflictDoUpdate((r: typeof schema.candle.$inferSelect) => ({
      high: price > r.high ? price : r.high,
      low: price < r.low ? price : r.low,
      close: price,
      volumeWeth: r.volumeWeth + vol,
    }));
}

// ── Factory ──────────────────────────────────────────────────────────────────
ponder.on("BallastFactory:Launched", async ({ event, context }) => {
  const token = event.args.token;
  await context.db
    .insert(schema.project)
    .values({
      id: token,
      treasury: event.args.treasury,
      creator: event.args.creator,
      metadataURI: event.args.metadataURI,
      launchMetadataURI: event.args.metadataURI,
      noticePeriod: event.args.noticePeriod,
      launchBlock: event.block.number,
      launchTimestamp: event.block.timestamp,
      graduated: false,
      holderCount: 0,
      feesWeth: 0n,
    })
    .onConflictDoNothing();
  await context.db.insert(schema.treasuryLink).values({ id: event.args.treasury, token }).onConflictDoNothing();
  await bumpProtocol(context, { launches: 1 });
});

ponder.on("BallastFactory:Graduated", async ({ event, context }) => {
  const token = event.args.token;
  const poolId = computePoolId(token);
  await context.db
    .update(schema.project, { id: token })
    .set({ graduated: true, tickLower: event.args.tickLower, backingUsd: event.args.backingUsd1e18, poolId });
  await context.db.insert(schema.pool).values({ id: poolId, token }).onConflictDoNothing();
  await bumpProtocol(context, { graduated: 1 });
});

// ── Token (factory child) ────────────────────────────────────────────────────
ponder.on("ProjectToken:Transfer", async ({ event, context }) => {
  const token = event.log.address;
  if (event.args.value === 0n) return;
  await adjustHolder(context, token, event.args.from, -event.args.value);
  await adjustHolder(context, token, event.args.to, event.args.value);
});

ponder.on("ProjectToken:MetadataUpdated", async ({ event, context }) => {
  const token = event.log.address;
  await context.db.insert(schema.metadataChange).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token,
    oldURI: event.args.oldURI,
    newURI: event.args.newURI,
    timestamp: event.args.timestamp,
    block: event.block.number,
  });
  await context.db.update(schema.project, { id: token }).set({ metadataURI: event.args.newURI });
});

// ── Treasury (factory child) ─────────────────────────────────────────────────
async function recordTreasury(
  context: Ctx,
  event: { log: { address: Hex; logIndex: number }; transaction: { hash: Hex }; block: { number: bigint; timestamp: bigint } },
  kind: string,
  asset: Hex,
  amount: bigint,
  party: Hex = ZERO,
  unlockAt: bigint = 0n,
) {
  const treasury = event.log.address;
  const link = await context.db.find(schema.treasuryLink, { id: treasury });
  await context.db.insert(schema.treasuryEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    treasury,
    token: (link?.token ?? treasury) as Hex,
    kind,
    asset,
    amount,
    party,
    unlockAt,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
}

ponder.on("ProjectTreasuryC:CreatorDeposited", async ({ event, context }) =>
  recordTreasury(context, event, "creator_deposit", event.args.asset, event.args.amount),
);
ponder.on("ProjectTreasuryC:DepositAccepted", async ({ event, context }) =>
  recordTreasury(context, event, "deposit_accepted", event.args.asset, event.args.amount, event.args.depositor),
);
ponder.on("ProjectTreasuryC:WithdrawalAnnounced", async ({ event, context }) =>
  recordTreasury(context, event, "withdrawal_announced", event.args.asset, event.args.amount, ZERO, event.args.unlockAt),
);
ponder.on("ProjectTreasuryC:WithdrawalExecuted", async ({ event, context }) =>
  recordTreasury(context, event, "withdrawal_executed", event.args.asset, event.args.amount),
);
ponder.on("ProjectTreasuryC:WithdrawalCancelled", async ({ event, context }) =>
  recordTreasury(context, event, "withdrawal_cancelled", event.args.asset, event.args.amount),
);

// ── Hook (fees) ──────────────────────────────────────────────────────────────
ponder.on("BallastHook:FeeTaken", async ({ event, context }) => {
  await context.db.insert(schema.feeEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token: event.args.token,
    feeWeth: event.args.feeWeth,
    creator: event.args.creator,
    platform: event.args.platform,
    referrer: event.args.referrer,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });
  await bumpProtocol(context, { fees: event.args.feeWeth });
  const p = await context.db.find(schema.project, { id: event.args.token });
  if (p) await context.db.update(schema.project, { id: event.args.token }).set({ feesWeth: p.feesWeth + event.args.feeWeth });
});

// ── Pool swaps (singleton PoolManager, filtered to BALLAST pools) ─────────────
ponder.on("PoolManager:Swap", async ({ event, context }) => {
  const pool = await context.db.find(schema.pool, { id: event.args.id });
  if (!pool) return; // not one of ours

  const token = pool.token as Hex;
  const amount0 = event.args.amount0; // token leg (currency0)
  const amount1 = event.args.amount1; // WETH leg (currency1)
  const tokenAmount = amount0 < 0n ? -amount0 : amount0;
  const wethAmount = amount1 < 0n ? -amount1 : amount1;
  // Pool sends token out (amount0 < 0) => a buy; sends token in => a sell.
  const side = amount0 < 0n ? "buy" : "sell";
  const priceWeth = priceFromSqrtX96(event.args.sqrtPriceX96);

  await context.db.insert(schema.trade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token,
    poolId: event.args.id,
    sender: event.args.sender,
    side,
    wethAmount,
    tokenAmount,
    priceWeth,
    tick: event.args.tick,
    timestamp: event.block.timestamp,
    block: event.block.number,
  });

  for (const [label, secs] of INTERVALS) {
    await upsertCandle(context, token, label, secs, event.block.timestamp, priceWeth, wethAmount);
  }
});
