import { defineChain } from "viem";

// Robinhood Chain — Arbitrum Orbit L2. Values from docs/robinhood-chain-research.md.
// Mainnet 4663, testnet 46630, gas token ETH, ~100ms blocks. The public RPC is
// rate-limited — a paid endpoint should be set via NEXT_PUBLIC_RPC_URL in prod.

const USE_MAINNET = process.env.NEXT_PUBLIC_USE_MAINNET === "true";

const MAINNET_RPC =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const TESTNET_RPC =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [MAINNET_RPC] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET_RPC] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const activeChain = USE_MAINNET ? robinhoodMainnet : robinhoodTestnet;
