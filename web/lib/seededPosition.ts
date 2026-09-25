import type { Address, Hex, PublicClient } from "viem";
import { stateViewAbi } from "./abis";
import { STATE_VIEW_ADDRESS } from "./contracts";

// Finds a BallastSeeder position's REAL tickLower/tickUpper on-chain, without the
// Seeded/PoolSeeded event log — this environment's RPC key is on a free tier that
// caps eth_getLogs at a 10-block range (confirmed 2026-09-25), so scanning back to
// an arbitrary graduation block isn't possible. Recomputing openTick "live" from
// current backing isn't safe either: openTick is fixed forever the moment
// graduate() runs, so a treasury deposit made AFTER graduation would make a live
// recompute diverge from the real seeded position (see docs/seeded-hook-history.md).
//
// Instead this reads the pool's real tick-initialized bitmap (the same storage
// BallastSeeder's own modifyLiquidity call wrote to) and finds the actual boundary
// ticks — correct at every price, including the half-open-tick-range artifact
// where getLiquidity(poolId) reads 0 exactly at the position's edge.
//
// Mirrors contracts/lib/v4-core/src/libraries/TickBitmap.sol exactly (compress /
// position / nextInitializedTickWithinOneWord) — verified against two real
// production pools before use (one where price has moved off the seed tick, one
// sitting exactly on the boundary); see the validation notes in that PR.

const TICK_SPACING = 60n;
// Mirrors BallastSeeder.RANGE_TICKS (contracts/src/BallastSeeder.sol) — the fixed
// span of every Ballast one-sided position, ~1000x in price. A protocol constant,
// never owner-settable, safe to mirror the same way TICK_SPACING already is.
export const RANGE_TICKS = 69060n;
// ceil(RANGE_TICKS / TICK_SPACING / 256) = ceil(1151/256) = 5, +1 margin.
const WORDS_TO_SEARCH = 6n;

function compress(tick: bigint, spacing: bigint): bigint {
  let q = tick / spacing;
  if (tick % spacing !== 0n && (tick < 0n) !== (spacing < 0n)) q -= 1n;
  return q;
}
function wordPos(compressed: bigint): bigint {
  return compressed >> 8n; // arithmetic shift == floor(compressed / 256)
}
function bitPos(compressed: bigint): bigint {
  let m = compressed % 256n;
  if (m < 0n) m += 256n;
  return m;
}
function highestSetBitAtOrBelow(word: bigint, bp: bigint): bigint | null {
  const mask = bp === 255n ? (1n << 256n) - 1n : (1n << (bp + 1n)) - 1n;
  const masked = word & mask;
  if (masked === 0n) return null;
  return BigInt(masked.toString(2).length - 1); // index of the highest set bit
}
function lowestSetBitAtOrAbove(word: bigint, bp: bigint): bigint | null {
  const mask = bp === 0n ? (1n << 256n) - 1n : ((1n << 256n) - 1n) ^ ((1n << bp) - 1n);
  const masked = word & mask;
  if (masked === 0n) return null;
  let i = 0n;
  let w = masked;
  while ((w & 1n) === 0n) {
    w >>= 1n;
    i += 1n;
  }
  return i;
}

async function getBitmapWord(client: PublicClient, poolId: Hex, wp: bigint): Promise<bigint> {
  return client.readContract({
    address: STATE_VIEW_ADDRESS!,
    abi: stateViewAbi,
    functionName: "getTickBitmap",
    args: [poolId, Number(wp)],
  }) as Promise<bigint>;
}

async function searchLte(client: PublicClient, poolId: Hex, startCompressed: bigint): Promise<bigint | null> {
  const wp = wordPos(startCompressed);
  const bp = bitPos(startCompressed);
  for (let i = 0n; i < WORDS_TO_SEARCH; i++) {
    const word = await getBitmapWord(client, poolId, wp - i);
    const bpEff = i === 0n ? bp : 255n;
    const hb = highestSetBitAtOrBelow(word, bpEff);
    if (hb !== null) return (wp - i) * 256n + hb;
  }
  return null;
}
async function searchGt(client: PublicClient, poolId: Hex, startCompressed: bigint): Promise<bigint | null> {
  const startSearch = startCompressed + 1n;
  const wp = wordPos(startSearch);
  const bp = bitPos(startSearch);
  for (let i = 0n; i < WORDS_TO_SEARCH; i++) {
    const word = await getBitmapWord(client, poolId, wp + i);
    const bpEff = i === 0n ? bp : 0n;
    const lb = lowestSetBitAtOrAbove(word, bpEff);
    if (lb !== null) return (wp + i) * 256n + lb;
  }
  return null;
}

/**
 * Find the seeded position's real [tickLower, tickUpper], reading the pool's
 * actual initialized-tick bitmap around `currentTick`. Returns undefined if no
 * initialized tick is found within the search window (not a genuine Ballast
 * pool, or STATE_VIEW_ADDRESS unset) — never guesses.
 */
export async function findSeededTicks(
  client: PublicClient,
  poolId: Hex,
  currentTick: number,
): Promise<{ tickLower: number; tickUpper: number } | undefined> {
  if (!STATE_VIEW_ADDRESS) return undefined;
  const compressedT = compress(BigInt(currentTick), TICK_SPACING);
  const [lte, gt] = await Promise.all([searchLte(client, poolId, compressedT), searchGt(client, poolId, compressedT)]);
  if (lte === null) return undefined;
  const lteTick = lte * TICK_SPACING;
  if (gt !== null) {
    const gtTick = gt * TICK_SPACING;
    if (gtTick - lteTick === RANGE_TICKS) return { tickLower: Number(lteTick), tickUpper: Number(gtTick) };
  }
  // Nothing initialized to the right within range => the found tick IS tickUpper
  // (the artifact case: current price sits exactly on the position's edge).
  return { tickLower: Number(lteTick - RANGE_TICKS), tickUpper: Number(lteTick) };
}

/**
 * True iff the position currently holds NO quote asset — i.e. no real buy has
 * ever moved price off the seed-time boundary on the quote-asset side. This is
 * an exact fact from tick comparison alone, not an approximation: mirroring
 * v4-periphery's LiquidityAmounts.getAmountsForLiquidity, amount1 == 0 exactly
 * when currentTick <= tickLower, and amount0 == 0 exactly when
 * currentTick >= tickUpper — so no need to compute the actual token amounts,
 * only which side of the boundary the current tick sits on.
 */
export function isQuoteSideEmpty(
  currentTick: number,
  ticks: { tickLower: number; tickUpper: number },
  quoteIsCurrency0: boolean,
): boolean {
  return quoteIsCurrency0 ? currentTick >= ticks.tickUpper : currentTick <= ticks.tickLower;
}

export type SeededPositionState = {
  currentTick: number;
  ticks: { tickLower: number; tickUpper: number };
  liquidity: bigint;
};

/**
 * The seeded LP position's full real, live state — current tick, the
 * position's real tickLower/tickUpper, and its actual liquidity, read via
 * StateView.getPositionInfo, owned by `seeder` (BallastFactory.seeder()),
 * salt 0 (the only salt BallastSeeder ever uses). Returns undefined on any
 * failure (never fabricates a value); liquidity 0n is a real, meaningful
 * answer (drained/never seeded), distinct from "couldn't check."
 */
export async function seededPositionState(
  client: PublicClient,
  poolId: Hex,
  seeder: Address,
): Promise<SeededPositionState | undefined> {
  if (!STATE_VIEW_ADDRESS) return undefined;
  const slot0 = (await client.readContract({
    address: STATE_VIEW_ADDRESS,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId],
  })) as readonly [bigint, number, number, number];
  const currentTick = slot0[1];
  const ticks = await findSeededTicks(client, poolId, currentTick);
  if (!ticks) return undefined;
  const ZERO_SALT: Hex = `0x${"0".repeat(64)}`;
  const [liquidity] = (await client.readContract({
    address: STATE_VIEW_ADDRESS,
    abi: stateViewAbi,
    functionName: "getPositionInfo",
    args: [poolId, seeder, ticks.tickLower, ticks.tickUpper, ZERO_SALT],
  })) as readonly [bigint, bigint, bigint];
  return { currentTick, ticks, liquidity };
}
