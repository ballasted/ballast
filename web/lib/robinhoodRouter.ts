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

// ── Native-ETH commands (Part 2: buy with ETH / sell to ETH) ─────────────────
// BALLAST pools are token/WETH, so ETH must be wrapped/unwrapped in the SAME
// execute() call — no separate wrapping step for the user. UniversalRouter runs
// commands in order, so:
//   BUY  (ETH → token): [WRAP_ETH, V4_SWAP]   with msg.value = amountIn
//   SELL (token → ETH): [V4_SWAP, UNWRAP_WETH] output taken to the router, then
//                        unwrapped to the user as ETH.
//
// ⚠️ UNPROVEN ON THIS FORK. The WETH-only path is proven (ProveSwapMainnet); the
// wrap/unwrap path is NOT. Two things MUST be pinned against the fork's own source
// on Blockscout and proven with a ProveSwapEth script BEFORE wiring:
//   1. Command ids — these are the STOCK universal-router values; this router is a
//      fork, so confirm its Commands enum (V4_SWAP=0x10 was the only one verified).
//   2. SETTLE semantics — the proven WETH path used SETTLE_ALL with the USER as
//      payer (Permit2 pull). After WRAP_ETH the WETH sits in the ROUTER, so the
//      swap must settle from the router, not pull from the user — that likely
//      needs SETTLE (payerIsUser=false) rather than SETTLE_ALL. Getting this wrong
//      reverts or strands funds. Prove it, don't guess it.
export const CMD_WRAP_ETH = "0x0b"; // inputs: (address recipient, uint256 amount)
export const CMD_UNWRAP_WETH = "0x0c"; // inputs: (address recipient, uint256 amountMin)

// UniversalRouter address sentinels (recipient/amount placeholders it substitutes).
export const UR_ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address; // the router itself
export const UR_MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address; // the caller
export const UR_CONTRACT_BALANCE = (1n << 255n); // "use the router's full balance"

/** v4 Action ids used inside a V4_SWAP input. Single-hop only — BALLAST does not
 *  ship multi-hop (SWAP_EXACT_IN = 0x07); see research §4. SETTLE (0x0b, with a
 *  payerIsUser flag) is added for the router-funded native-ETH path above. */
export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b, // (currency, amount, payerIsUser) — payer=router after WRAP_ETH
  SETTLE_ALL: 0x0c, // (currency, maxAmount) — payer=user via Permit2 (proven WETH path)
  TAKE: 0x0e, // (currency, recipient, amount) — take output to router before UNWRAP
  TAKE_ALL: 0x0f, // (currency, minAmount) — take output to the user (WETH path)
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

// Multi-hop (ExactInputParams, with minHopPriceX36 as uint256[]) is intentionally
// omitted — BALLAST is single-hop only. The verified shape lives in research §4.

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
