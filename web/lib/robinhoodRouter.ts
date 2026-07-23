// Encoding reference for the MODIFIED UniversalRouter on Robinhood Chain.
//
// ⚠️ This chain's UniversalRouter is a FORK: its v4 swap params carry an extra
// `minHopPriceX36` field that the stock @uniswap/* SDKs omit — SDK calldata will
// REVERT here. Build calldata manually with the shapes below. Verified 2026-07-23
// against the deployed contract's Blockscout source (see
// docs/robinhood-chain-research.md §4 and contracts/src/interfaces/IRobinhoodV4Router.sol).
//
// TWO look-alike routers exist on this chain — only the address below is correct;
// re-verify before routing value. Not wired into a live swap yet (Buy/Sell are
// disabled until a pool exists); this is the reference the swap UI will use.

import type { Address } from "viem";

/** Verified fork address. Prefer NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS at runtime. */
export const UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address;

/** UniversalRouter command id for a v4 swap. */
export const CMD_V4_SWAP = "0x10";

/** v4 Action ids used inside a V4_SWAP input. */
export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
} as const;

// abi params for the SINGLE-hop swap struct (what a graduated token/WETH pool
// needs). `minHopPriceX36` is the fork addition (scalar uint256), after
// amountOutMinimum and before hookData. Set 0n to disable; rely on
// amountOutMinimum for slippage.
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
    { name: "minHopPriceX36", type: "uint256" }, // FORK-ONLY; 0 = disabled
    { name: "hookData", type: "bytes" },
  ],
} as const;

// Multi-hop variant. ⚠️ Field order verified against the deployed IV4Router.sol
// source: minHopPriceX36 (uint256[]) is the THIRD field — after `path`, BEFORE
// `amountIn` — NOT trailing. Length 0 (disabled) or exactly path.length, else the
// router reverts InvalidHopPriceLength.
export const exactInputParamsAbi = {
  type: "tuple",
  components: [
    { name: "currencyIn", type: "address" },
    {
      name: "path",
      type: "tuple[]",
      components: [
        { name: "intermediateCurrency", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
        { name: "hookData", type: "bytes" },
      ],
    },
    { name: "minHopPriceX36", type: "uint256[]" }, // FORK-ONLY, 3rd field; [] = disabled
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
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
      { name: "deadline", type: "uint256" }, // TIMESTAMP — ~100ms blocks
    ],
    outputs: [],
  },
] as const;
