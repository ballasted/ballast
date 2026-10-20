import { concatHex, encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { ADDRESSES } from "./constants/addresses";

// Ported from web/lib/{pool,robinhoodRouter,swap}.ts — the PROVEN encoding for
// this chain's FORKED UniversalRouter (extra `minHopPriceX36` field; stock
// Uniswap SDK calldata reverts here). A Ballast pool is token/quoteAsset, fee 0
// (the hook takes the fee on the quote leg), tickSpacing 60, singleton hook.

export const TICK_SPACING = 60;

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export function tokenIsCurrency0(token: Address, quoteAsset: Address): boolean {
  return token.toLowerCase() < quoteAsset.toLowerCase();
}

export function poolKeyForToken(token: Address, quoteAsset: Address, hook: Address = ADDRESSES.hook): PoolKey {
  const [c0, c1] = tokenIsCurrency0(token, quoteAsset) ? [token, quoteAsset] : [quoteAsset, token];
  return { currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: hook };
}

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

export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key]));
}

/** zeroForOne for BUYING `token` (spending the quote asset to receive it). */
export function buyZeroForOne(token: Address, quoteAsset: Address): boolean {
  return !tokenIsCurrency0(token, quoteAsset);
}
/** zeroForOne for SELLING `token`. */
export function sellZeroForOne(token: Address, quoteAsset: Address): boolean {
  return tokenIsCurrency0(token, quoteAsset);
}

/** Spot price of `token` in 1e18-scaled whole units of `quoteAsset`. */
export function tokenPriceInQuote(sqrtPriceX96: bigint, tokenIsCurrency0Side: boolean, quoteDecimals: number): bigint {
  const rawRatioWad = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
  const decAdj = quoteDecimals === 18 ? rawRatioWad : (rawRatioWad * 10n ** 18n) / 10n ** BigInt(quoteDecimals);
  return tokenIsCurrency0Side ? decAdj : decAdj === 0n ? 0n : (10n ** 36n) / decAdj;
}

// ── Forked UniversalRouter encoding (verified; see robinhood-chain-research §4) ──
export const CMD_V4_SWAP = "0x10";
export const CMD_WRAP_ETH = "0x0b";
export const CMD_UNWRAP_WETH = "0x0c";
export const UR_ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
export const UR_MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;
export const UR_CONTRACT_BALANCE = 1n << 255n;

export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

export const exactInputSingleParamsAbi = {
  type: "tuple",
  components: [
    {
      name: "poolKey",
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "minHopPriceX36", type: "uint256" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

export const universalRouterExecuteAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const SETTLE_ABI = [{ type: "address" }, { type: "uint256" }, { type: "bool" }] as const;
const SETTLE_ALL_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const TAKE_ABI = [{ type: "address" }, { type: "address" }, { type: "uint256" }] as const;
const TAKE_ALL_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const WRAP_UNWRAP_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const V4_SWAP_INPUT_ABI = [{ type: "bytes" }, { type: "bytes[]" }] as const;

export type SwapSide = "buy" | "sell";

/** Build the native-ETH ⇆ token swap for a WETH-quoted Ballast pool (the primary
 *  path). Buy wraps ETH inside execute(); sell unwraps WETH to ETH. */
export function buildV4SwapInput(args: {
  token: Address;
  side: SwapSide;
  amountIn: bigint;
  amountOutMinimum: bigint;
  hook?: Address;
  weth?: Address;
}): { commands: Hex; inputs: Hex[]; value: bigint } {
  const weth = args.weth ?? ADDRESSES.weth;
  const key = poolKeyForToken(args.token, weth, args.hook);
  const isBuy = args.side === "buy";
  const zeroForOne = isBuy ? buyZeroForOne(args.token, weth) : sellZeroForOne(args.token, weth);
  const swapParams = encodeAbiParameters([exactInputSingleParamsAbi], [
    { poolKey: key, zeroForOne, amountIn: args.amountIn, amountOutMinimum: args.amountOutMinimum, minHopPriceX36: 0n, hookData: "0x" },
  ]);

  if (isBuy) {
    const wrap = encodeAbiParameters(WRAP_UNWRAP_ABI, [UR_ADDRESS_THIS, UR_CONTRACT_BALANCE]);
    const settle = encodeAbiParameters(SETTLE_ABI, [weth, UR_CONTRACT_BALANCE, false]);
    const takeAll = encodeAbiParameters(TAKE_ALL_ABI, [args.token, args.amountOutMinimum]);
    const actions = concatHex([
      toHex(V4_ACTIONS.SWAP_EXACT_IN_SINGLE, { size: 1 }),
      toHex(V4_ACTIONS.SETTLE, { size: 1 }),
      toHex(V4_ACTIONS.TAKE_ALL, { size: 1 }),
    ]);
    const v4Input = encodeAbiParameters(V4_SWAP_INPUT_ABI, [actions, [swapParams, settle, takeAll]]);
    return { commands: concatHex([CMD_WRAP_ETH, CMD_V4_SWAP]), inputs: [wrap, v4Input], value: args.amountIn };
  }

  const settleAll = encodeAbiParameters(SETTLE_ALL_ABI, [args.token, args.amountIn]);
  const take = encodeAbiParameters(TAKE_ABI, [weth, UR_ADDRESS_THIS, 0n]);
  const actions = concatHex([
    toHex(V4_ACTIONS.SWAP_EXACT_IN_SINGLE, { size: 1 }),
    toHex(V4_ACTIONS.SETTLE_ALL, { size: 1 }),
    toHex(V4_ACTIONS.TAKE, { size: 1 }),
  ]);
  const v4Input = encodeAbiParameters(V4_SWAP_INPUT_ABI, [actions, [swapParams, settleAll, take]]);
  const unwrap = encodeAbiParameters(WRAP_UNWRAP_ABI, [UR_MSG_SENDER, args.amountOutMinimum]);
  return { commands: concatHex([CMD_V4_SWAP, CMD_UNWRAP_WETH]), inputs: [v4Input, unwrap], value: 0n };
}

/** The single source of truth for a swap's minOut given a quote + slippage bps. */
export function computeMinOut(quote: bigint | undefined, slippageBps: number): bigint {
  if (quote === undefined || quote <= 0n || slippageBps >= 10000) return 0n;
  const bps = slippageBps < 0 ? 0 : Math.trunc(slippageBps);
  return (quote * BigInt(10000 - bps)) / 10000n;
}

/** A timestamp deadline (blocks are ~100ms; never use block numbers). */
export function swapDeadline(nowSec: number, secondsOut = 600): bigint {
  return BigInt((nowSec > 0 ? nowSec : 0) + secondsOut);
}
