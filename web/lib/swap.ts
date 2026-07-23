import { concatHex, encodeAbiParameters, toHex, type Address, type Hex } from "viem";
import {
  V4_ACTIONS,
  exactInputSingleParamsAbi,
} from "./robinhoodRouter";
import { poolKeyForToken, BUY_ZERO_FOR_ONE, SELL_ZERO_FOR_ONE, type PoolKey } from "./pool";
import { WETH_ADDRESS } from "./contracts";

export type SwapSide = "buy" | "sell";

// v4 action param encodings.
const SETTLE_TAKE_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const V4_SWAP_INPUT_ABI = [{ type: "bytes" }, { type: "bytes[]" }] as const;

/**
 * Build the UniversalRouter V4_SWAP input for an exact-in single-hop swap on this
 * chain's FORKED router. A BALLAST token is currency0 (below WETH):
 *   buy  = spend WETH (currency1) for token (currency0), zeroForOne = false
 *   sell = spend token (currency0) for WETH (currency1), zeroForOne = true
 *
 * Actions: SWAP_EXACT_IN_SINGLE -> SETTLE_ALL(input) -> TAKE_ALL(output). The
 * swap params carry the fork-only `minHopPriceX36` (0 = disabled; slippage is
 * enforced by amountOutMinimum). WETH is an ERC-20 here, so the input is pulled
 * through Permit2 — grant that allowance before calling (see useSwap).
 */
export function buildV4SwapInput(args: {
  token: Address;
  side: SwapSide;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): { commands: Hex; inputs: Hex[] } | null {
  const key = poolKeyForToken(args.token);
  if (!key || !WETH_ADDRESS) return null;

  const isBuy = args.side === "buy";
  const zeroForOne = isBuy ? BUY_ZERO_FOR_ONE : SELL_ZERO_FOR_ONE;
  const currencyIn = isBuy ? WETH_ADDRESS : args.token;
  const currencyOut = isBuy ? args.token : WETH_ADDRESS;

  const swapParams = encodeAbiParameters([exactInputSingleParamsAbi], [
    {
      poolKey: keyTuple(key),
      zeroForOne,
      amountIn: args.amountIn,
      amountOutMinimum: args.amountOutMinimum,
      minHopPriceX36: 0n, // fork field; slippage via amountOutMinimum
      hookData: "0x",
    },
  ]);
  const settle = encodeAbiParameters(SETTLE_TAKE_ABI, [currencyIn, args.amountIn]);
  const take = encodeAbiParameters(SETTLE_TAKE_ABI, [currencyOut, args.amountOutMinimum]);

  const actions = concatHex([
    toHex(V4_ACTIONS.SWAP_EXACT_IN_SINGLE, { size: 1 }),
    toHex(V4_ACTIONS.SETTLE_ALL, { size: 1 }),
    toHex(V4_ACTIONS.TAKE_ALL, { size: 1 }),
  ]);

  const v4Input = encodeAbiParameters(V4_SWAP_INPUT_ABI, [actions, [swapParams, settle, take]]);

  return {
    commands: toHex(0x10, { size: 1 }), // single V4_SWAP command
    inputs: [v4Input],
  };
}

// viem wants the tuple as a plain object matching the ABI component order.
function keyTuple(k: PoolKey) {
  return {
    currency0: k.currency0,
    currency1: k.currency1,
    fee: k.fee,
    tickSpacing: k.tickSpacing,
    hooks: k.hooks,
  };
}

/** A generous timestamp deadline. Blocks are ~100ms; use time, never block number. */
export function swapDeadline(nowSec: number, secondsOut = 600): bigint {
  return BigInt((nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000)) + secondsOut);
}
