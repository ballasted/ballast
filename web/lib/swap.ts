import { concatHex, encodeAbiParameters, toHex, type Address, type Hex } from "viem";
import {
  V4_ACTIONS,
  CMD_V4_SWAP,
  CMD_WRAP_ETH,
  CMD_UNWRAP_WETH,
  UR_ADDRESS_THIS,
  UR_MSG_SENDER,
  UR_CONTRACT_BALANCE,
  exactInputSingleParamsAbi,
} from "./robinhoodRouter";
import { poolKeyForToken, BUY_ZERO_FOR_ONE, SELL_ZERO_FOR_ONE, type PoolKey } from "./pool";
import { WETH_ADDRESS } from "./contracts";

export type SwapSide = "buy" | "sell";

// v4 action param encodings, verified against the DEPLOYED fork's Actions.sol +
// V4Router.sol (not the Uniswap SDK — this router is modified):
//   SETTLE      (currency, amount, payerIsUser)  — payer=router when false
//   SETTLE_ALL  (currency, maxAmount)            — payer is ALWAYS msgSender()
//   TAKE        (currency, recipient, amount)     — amount 0 (OPEN_DELTA) = full credit
//   TAKE_ALL    (currency, minAmount)            — recipient is ALWAYS msgSender()
// and UniversalRouter WRAP_ETH / UNWRAP_WETH inputs: (recipient, amount).
const SETTLE_ABI = [{ type: "address" }, { type: "uint256" }, { type: "bool" }] as const;
const SETTLE_ALL_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const TAKE_ABI = [{ type: "address" }, { type: "address" }, { type: "uint256" }] as const;
const TAKE_ALL_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const WRAP_UNWRAP_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const V4_SWAP_INPUT_ABI = [{ type: "bytes" }, { type: "bytes[]" }] as const;

/**
 * Build a single-hop exact-in swap for this chain's FORKED UniversalRouter, doing
 * the ETH wrap/unwrap INSIDE the same execute() call — one transaction, one
 * signature, never a separate wrap tx. A BALLAST token is currency0 (below WETH).
 *
 *   BUY  (ETH → token): commands [WRAP_ETH, V4_SWAP], msg.value = amountIn.
 *     WRAP_ETH mints WETH to the ROUTER (ADDRESS_THIS); the swap then SETTLEs that
 *     WETH from the router (payerIsUser=false) — so the WETH never touches the
 *     user's wallet and NO Permit2 pull is involved. Output token TAKE_ALL → user.
 *
 *   SELL (token → ETH): commands [V4_SWAP, UNWRAP_WETH], msg.value = 0.
 *     The token IS in the user's wallet, so SETTLE_ALL pulls it via Permit2
 *     (payer is always msgSender) — the sell STILL needs the two Permit2 approvals.
 *     Output WETH is TAKEn to the ROUTER, then UNWRAP_WETH sends native ETH to the
 *     user (reverting if below minOut — the sell's slippage guard).
 *
 * The swap params carry the fork-only `minHopPriceX36` (0 = disabled; slippage is
 * enforced by amountOutMinimum / the unwrap min). Returns the msg.value to send.
 */
export function buildV4SwapInput(args: {
  token: Address;
  side: SwapSide;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): { commands: Hex; inputs: Hex[]; value: bigint } | null {
  const key = poolKeyForToken(args.token);
  if (!key || !WETH_ADDRESS) return null;

  const isBuy = args.side === "buy";
  const zeroForOne = isBuy ? BUY_ZERO_FOR_ONE : SELL_ZERO_FOR_ONE;

  const swapParams = encodeAbiParameters([exactInputSingleParamsAbi], [
    {
      poolKey: keyTuple(key),
      zeroForOne,
      amountIn: args.amountIn,
      amountOutMinimum: args.amountOutMinimum,
      minHopPriceX36: 0n, // fork field; slippage via amountOutMinimum / unwrap min
      hookData: "0x",
    },
  ]);

  if (isBuy) {
    // WRAP_ETH the router's whole ETH balance (= msg.value) into WETH it holds.
    const wrap = encodeAbiParameters(WRAP_UNWRAP_ABI, [UR_ADDRESS_THIS, UR_CONTRACT_BALANCE]);
    // SETTLE the router's WETH (CONTRACT_BALANCE, NOT 0 — _settle no-ops on 0) with
    // payerIsUser=false so the router funds the input, not a Permit2 pull.
    const settle = encodeAbiParameters(SETTLE_ABI, [WETH_ADDRESS, UR_CONTRACT_BALANCE, false]);
    // TAKE_ALL sends the output token to msgSender (the user); minAmount = minOut.
    const takeAll = encodeAbiParameters(TAKE_ALL_ABI, [args.token, args.amountOutMinimum]);
    const actions = concatHex([
      toHex(V4_ACTIONS.SWAP_EXACT_IN_SINGLE, { size: 1 }),
      toHex(V4_ACTIONS.SETTLE, { size: 1 }),
      toHex(V4_ACTIONS.TAKE_ALL, { size: 1 }),
    ]);
    const v4Input = encodeAbiParameters(V4_SWAP_INPUT_ABI, [actions, [swapParams, settle, takeAll]]);
    return {
      commands: concatHex([CMD_WRAP_ETH, CMD_V4_SWAP]),
      inputs: [wrap, v4Input],
      value: args.amountIn, // native ETH to wrap
    };
  }

  // SELL: pull the token from the user (Permit2), take WETH out to the router, then
  // unwrap it to native ETH for the user.
  const settleAll = encodeAbiParameters(SETTLE_ALL_ABI, [args.token, args.amountIn]);
  // TAKE the full WETH credit (amount 0 = OPEN_DELTA) to the ROUTER so it can unwrap.
  const take = encodeAbiParameters(TAKE_ABI, [WETH_ADDRESS, UR_ADDRESS_THIS, 0n]);
  const actions = concatHex([
    toHex(V4_ACTIONS.SWAP_EXACT_IN_SINGLE, { size: 1 }),
    toHex(V4_ACTIONS.SETTLE_ALL, { size: 1 }),
    toHex(V4_ACTIONS.TAKE, { size: 1 }),
  ]);
  const v4Input = encodeAbiParameters(V4_SWAP_INPUT_ABI, [actions, [swapParams, settleAll, take]]);
  // UNWRAP_WETH the router's WETH to native ETH for the user; reverts if < minOut.
  const unwrap = encodeAbiParameters(WRAP_UNWRAP_ABI, [UR_MSG_SENDER, args.amountOutMinimum]);
  return {
    commands: concatHex([CMD_V4_SWAP, CMD_UNWRAP_WETH]),
    inputs: [v4Input, unwrap],
    value: 0n,
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
