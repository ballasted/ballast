import { encodeAbiParameters, encodeFunctionData, type Address } from "viem";
import { basketStockBuyerAbi } from "./abis";
import { routerV2RoutesFor } from "./routerV2";

// Pure builders for the stock round-up leg. No wallet/network — so the call
// encoding and minOut math are unit-tested in isolation (roundup.test.ts). The
// hook (useRoundup) handles quoting + EIP-5792 batching on top of these.

export type RoundupCall = { to: Address; data: `0x${string}`; value?: bigint };

/**
 * abi.encode(uint256[] fablesHopIdx, uint256[] ramsesHopIdx, bool preferFables,
 * uint256 deadline) — EXACTLY what BasketStockBuyer.buyStockWithETH decodes
 * (contracts/src/BasketStockBuyer.sol). Indices come from routerV2.ts's
 * ROUTES_BY_QUOTE_ASSET, the same verbatim tables the buyer was constructed with.
 */
export function encodeStockRoute(args: {
  fablesHopIdx: number[];
  ramsesHopIdx: number[];
  preferFables: boolean;
  deadline: bigint;
}): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "bool" }, { type: "uint256" }],
    [args.fablesHopIdx.map((i) => BigInt(i)), args.ramsesHopIdx.map((i) => BigInt(i)), args.preferFables, args.deadline],
  );
}

/**
 * The stock-only round-up call for an EIP-5792 batch (or a standalone fallback
 * tx): BasketStockBuyer.buyStockWithETH{value: roundupEthWei}(stock, recipient,
 * minStockOut, route). Returns undefined when BallastRouterV2/BasketStockBuyer
 * has no route for the stock (so the round-up is simply skipped, never guessed).
 */
export function buildRoundupBuyCall(args: {
  stockBuyer: Address;
  stock: Address;
  recipient: Address;
  roundupEthWei: bigint;
  minStockOut: bigint;
  preferFables: boolean;
  deadline: bigint;
}): RoundupCall | undefined {
  const routes = routerV2RoutesFor(args.stock);
  if (!routes) return undefined;
  const route = encodeStockRoute({
    fablesHopIdx: routes.fablesHopIdx,
    ramsesHopIdx: routes.ramsesHopIdx,
    preferFables: args.preferFables,
    deadline: args.deadline,
  });
  return {
    to: args.stockBuyer,
    value: args.roundupEthWei,
    data: encodeFunctionData({
      abi: basketStockBuyerAbi,
      functionName: "buyStockWithETH",
      args: [args.stock, args.recipient, args.minStockOut, route],
    }),
  };
}

/** Whether a stock is routable for a round-up (has a BallastRouterV2 route). */
export function isRoundupRoutable(stock: Address): boolean {
  return routerV2RoutesFor(stock) !== undefined;
}

/** Which venue to prefer. Fables when the stock has a Fables route, else Ramses
 *  (SGOV/GOOGL/MSFT/AMD/ORCL are Ramses-only — empty fablesHopIdx). The contract
 *  tries the preferred venue then falls back, so this is a hint, not a hard pick. */
export function preferFablesFor(stock: Address): boolean {
  const r = routerV2RoutesFor(stock);
  return Boolean(r && r.fablesHopIdx.length > 0);
}

/** minStockOut = quoted × (1 − slippageBps/1e4), floored at 1 (the contract
 *  requires minStockOut > 0). A 0 quote (no quote yet) yields 1 — a safety floor,
 *  never a real guarantee; the caller should block the trade until a quote exists. */
export function roundupMinOut(quoted: bigint, slippageBps: number): bigint {
  if (quoted <= 0n) return 1n;
  const out = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  return out > 0n ? out : 1n;
}
