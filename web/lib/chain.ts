import { defineChain } from "viem";

// Robinhood Chain — Arbitrum Orbit L2. This is the ONLY network BALLAST supports,
// so it is the only chain defined here and the only chain in the wagmi config.
//
// Values from docs/robinhood-chain-research.md: mainnet id 4663, gas token ETH,
// ~100ms blocks, Multicall3 canonical. The public RPC is rate-limited — set
// NEXT_PUBLIC_RPC_URL to a dedicated endpoint (Alchemy) in prod.
//
// Why a single chain: wagmi treats a connected chain that is absent from its
// `chains` array as unsupported and falls back to `chains[0]`. The previous
// config listed BOTH a mainnet and a testnet entry and toggled the *active* one
// off NEXT_PUBLIC_USE_MAINNET (defaulted false → testnet 46630). A wallet on real
// mainnet 4663 therefore mismatched the app's target and wagmi reported the wrong
// id — the "undefined"/id-1 fallback the launch bug surfaced. One chain, no toggle.

// Public Robinhood RPC. Two jobs: it's what wallet_addEthereumChain hands the
// user's wallet (which must reach it directly — a same-origin proxy is useless
// there), and it's the client transport's fallback. The app's OWN reads go
// through the /api/rpc proxy (lib/wagmi.ts), which holds the dedicated RPC key
// server-side — so no RPC key ever reaches the browser bundle.
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [PUBLIC_RPC_URL] },
    public: { http: [PUBLIC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

// The app targets exactly one network. `activeChain` and `robinhoodMainnet` are
// kept as aliases so existing imports keep working without threading a choice.
export const activeChain = robinhoodChain;
export const robinhoodMainnet = robinhoodChain;
