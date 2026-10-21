import { defineChain } from "viem";

/** Robinhood Chain mainnet — Arbitrum Orbit L2, gas token ETH, ~100ms blocks.
 *  RPC URLs are intentionally NOT hardcoded with keys; pass your own transport. */
export const ROBINHOOD_CHAIN_ID = 4663 as const;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630 as const;

/** A viem Chain for 4663. The public RPC is rate-limited — prefer your own, and
 *  batch reads through Multicall3 (CLAUDE.md chain gotchas). */
export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});
