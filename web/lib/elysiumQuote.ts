import {
  keccak256,
  encodePacked,
  pad,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { poolKeyForToken, poolId, buyZeroForOne, sellZeroForOne } from "./pool";
import type { SwapSide } from "./swap";

// ─────────────────────────────────────────────────────────────────────────────
// Elysium (gen-5) quoting WITHOUT a deployed V4Quoter / StateView.
//
// Those periphery contracts are not (yet) sourced on 99901, so instead of a
// contract call we read the pool's live state straight out of the PoolManager with
// `extsload` (the exact same storage StateView would expose) and compute the
// exact-in output with the standard Uniswap v4 single-tick math. A freshly
// graduated Ballast pool seeds the full supply as one wide range, so a trade stays
// within the current tick for all but the largest orders — within a tick this is
// EXACT, not an approximation; beyond it it slightly OVER-estimates output, which
// the on-chain amountOutMinimum (slippage guard) then rejects rather than letting a
// bad fill through. If NEXT_PUBLIC_V4_QUOTER_ADDRESS is ever set, useSwap uses the
// real quoter instead and this becomes the fallback.
//
// The gen-5 hook takes the creator fee on the QUOTE leg only: a buy pays the fee out
// of the quote input (so the pool swaps amountIn − fee); a sell has the fee skimmed
// from the quote output. We mirror that here so the quote matches the chain.
// ─────────────────────────────────────────────────────────────────────────────

const Q96 = 1n << 96n;
const BPS = 10_000n;
const MASK_160 = (1n << 160n) - 1n;
const MASK_128 = (1n << 128n) - 1n;

// StateLibrary: _pools mapping is at slot 6; liquidity sits 3 slots past slot0.
const POOLS_SLOT = pad(toHex(6n), { size: 32 });
const LIQUIDITY_OFFSET = 3n;

export const poolManagerExtsloadAbi = [
  {
    type: "function",
    name: "extsload",
    stateMutability: "view",
    inputs: [{ name: "slot", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export type ElysiumPoolState = {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
};

/** keccak256(abi.encodePacked(poolId, POOLS_SLOT)) — the pool's state base slot. */
function poolStateSlot(id: Hex): Hex {
  return keccak256(encodePacked(["bytes32", "bytes32"], [id, POOLS_SLOT]));
}

/** Read slot0 (sqrtPriceX96, tick) and liquidity for a pool directly from the
 *  PoolManager. Returns null if the pool is uninitialised (sqrtPrice 0) or on any
 *  read failure. */
export async function readElysiumPoolState(
  client: PublicClient,
  poolManager: Address,
  id: Hex,
): Promise<ElysiumPoolState | null> {
  try {
    const base = poolStateSlot(id);
    const liqSlot = pad(toHex((BigInt(base) + LIQUIDITY_OFFSET) & ((1n << 256n) - 1n)), {
      size: 32,
    });
    const [slot0Raw, liqRaw] = await Promise.all([
      client.readContract({
        address: poolManager,
        abi: poolManagerExtsloadAbi,
        functionName: "extsload",
        args: [base],
      }),
      client.readContract({
        address: poolManager,
        abi: poolManagerExtsloadAbi,
        functionName: "extsload",
        args: [liqSlot],
      }),
    ]);
    const packed = BigInt(slot0Raw as Hex);
    const sqrtPriceX96 = packed & MASK_160;
    if (sqrtPriceX96 === 0n) return null; // uninitialised pool
    const tickRaw = Number((packed >> 160n) & 0xffffffn);
    const tick = tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw; // int24 sign
    const liquidity = BigInt(liqRaw as Hex) & MASK_128;
    return { sqrtPriceX96, tick, liquidity };
  } catch {
    return null;
  }
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

// Uniswap v4 SqrtPriceMath, exact-in, add branch (bigint — no uint overflow).
function nextSqrtPriceFromAmount0(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = L << 96n;
  const denominator = numerator1 + amount * sqrtP;
  return ceilDiv(numerator1 * sqrtP, denominator);
}

function nextSqrtPriceFromAmount1(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  return sqrtP + (amount << 96n) / L;
}

function amount0Delta(a: bigint, b: bigint, L: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (lo === 0n) return 0n;
  return ((L << 96n) * (hi - lo)) / hi / lo;
}

function amount1Delta(a: bigint, b: bigint, L: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return (L * (hi - lo)) / Q96;
}

/** Exact-in output within the current tick. Pool fee is 0 on Ballast pools (the hook
 *  takes the creator fee separately), so no fee term here. */
export function exactInSingleTick(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (liquidity === 0n || amountIn === 0n || sqrtPriceX96 === 0n) return 0n;
  if (zeroForOne) {
    const next = nextSqrtPriceFromAmount0(sqrtPriceX96, liquidity, amountIn);
    return amount1Delta(next, sqrtPriceX96, liquidity);
  }
  const next = nextSqrtPriceFromAmount1(sqrtPriceX96, liquidity, amountIn);
  return amount0Delta(sqrtPriceX96, next, liquidity);
}

/** Full gen-5 exact-in quote for token/quoteAsset at the current pool state,
 *  including the hook's creator fee on the quote leg. Returns 0n when not quotable. */
export async function quoteElysiumExactIn(args: {
  client: PublicClient;
  poolManager: Address;
  token: Address;
  quoteAsset: Address;
  hook: Address;
  feeBps: number; // the pool's creator fee (BallastHookV5.poolFeeBps)
  side: SwapSide;
  amountIn: bigint;
}): Promise<bigint> {
  const { client, poolManager, token, quoteAsset, hook, feeBps, side, amountIn } = args;
  if (amountIn <= 0n) return 0n;
  const key = poolKeyForToken(token, quoteAsset, hook);
  if (!key) return 0n;
  const state = await readElysiumPoolState(client, poolManager, poolId(key));
  if (!state) return 0n;
  const fee = BigInt(Math.max(0, Math.trunc(feeBps)));

  if (side === "buy") {
    // Quote is the INPUT; the hook skims the fee off the input before the swap.
    const poolIn = amountIn - (amountIn * fee) / BPS;
    const zeroForOne = buyZeroForOne(token, quoteAsset);
    return exactInSingleTick(state.sqrtPriceX96, state.liquidity, poolIn, zeroForOne);
  }
  // Sell: token is the input; quote is the OUTPUT, fee skimmed off the output.
  const zeroForOne = sellZeroForOne(token, quoteAsset);
  const grossOut = exactInSingleTick(state.sqrtPriceX96, state.liquidity, amountIn, zeroForOne);
  return grossOut - (grossOut * fee) / BPS;
}
