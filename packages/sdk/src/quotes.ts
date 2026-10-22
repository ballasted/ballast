import type { Address } from "viem";
import type { Ctx } from "./client";
import { poolKeyForToken, buyZeroForOne, sellZeroForOne, computeMinOut, type SwapSide } from "./pool";
import { SimulationError } from "./errors";

// Quotes for a WETH-quoted Ballast pool via the external V4Quoter (PoolManager-
// generic, not hook-specific) — the same call hooks/useSwap.ts makes. The quoter
// is `nonpayable` but non-mutating, so it's invoked through eth_call
// (simulateContract). Non-WETH-quoted pools (NVDA/SPY/SGOV) route over
// Fables/Ramses in the app (lib/routerV2.ts) and are a documented SDK extension
// point — not yet quoted here (see README "Known limitations").

const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
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
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export interface Quote {
  /** Expected output amount (token for a buy, WETH-wei for a sell). */
  amountOut: bigint;
  /** minOut after applying slippageBps (0 if no slippage requested). */
  minOut: bigint;
  gasEstimate: bigint;
}

async function quote(ctx: Ctx, token: Address, side: SwapSide, amountIn: bigint, slippageBps: number, hook?: Address): Promise<Quote> {
  const weth = ctx.addr.weth;
  const key = poolKeyForToken(token, weth, hook ?? ctx.addr.hook);
  try {
    const { result } = await ctx.pub.simulateContract({
      address: ctx.addr.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: key,
          zeroForOne: side === "buy" ? buyZeroForOne(token, weth) : sellZeroForOne(token, weth),
          exactAmount: amountIn,
          hookData: "0x",
        },
      ],
    });
    const amountOut = (result as readonly [bigint, bigint])[0];
    const gasEstimate = (result as readonly [bigint, bigint])[1];
    return { amountOut, minOut: computeMinOut(amountOut, slippageBps), gasEstimate };
  } catch (e) {
    throw new SimulationError("Quote failed", (e as Error)?.message, e);
  }
}

/** Quote buying `token` with `ethIn` wei of ETH (WETH pool). */
export function quoteBuy(ctx: Ctx, args: { token: Address; ethIn: bigint; slippageBps?: number; hook?: Address }): Promise<Quote> {
  return quote(ctx, args.token, "buy", args.ethIn, args.slippageBps ?? 100, args.hook);
}

/** Quote selling `tokenIn` wei of `token` for ETH (WETH pool). */
export function quoteSell(ctx: Ctx, args: { token: Address; tokenIn: bigint; slippageBps?: number; hook?: Address }): Promise<Quote> {
  return quote(ctx, args.token, "sell", args.tokenIn, args.slippageBps ?? 100, args.hook);
}
