import { fallback, http } from "viem";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain as defineAppKitChain, type AppKitNetwork } from "@reown/appkit/networks";
import { robinhoodChain, PUBLIC_RPC_URL } from "./chain";

// Wallet layer. Imported ONLY by the /app provider, so no web3 (or reown) code is
// pulled into the marketing bundle.
//
// reown AppKit (WalletConnect v2) drives a multi-wallet picker — MetaMask, the
// WalletConnect QR, Binance/SafePal/Trust, and the searchable list — so a phone
// browser with no extension can still connect. The wagmi config comes from the
// AppKit adapter; wagmi hooks (useAccount, useSwitchChain, …) keep working as
// before on top of it.

export const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
export const appKitEnabled = projectId.length > 0;

// Reads go through the same-origin /api/rpc proxy (dedicated key server-side),
// falling back to the public Robinhood RPC if the proxy errors or during SSR.
export const RPC_TRANSPORT = fallback([
  http("/api/rpc", { batch: true }),
  http(PUBLIC_RPC_URL, { batch: true }),
]);

// AppKit needs the chain in its own CAIP-tagged shape; mirror lib/chain.ts exactly
// so the wallet picker, the wagmi config, and wallet_addEthereumChain all describe
// the same single network (4663).
export const robinhoodNetwork = defineAppKitChain({
  id: 4663,
  caipNetworkId: "eip155:4663",
  chainNamespace: "eip155",
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
}) as AppKitNetwork;

export const wagmiAdapter = new WagmiAdapter({
  networks: [robinhoodNetwork],
  // A non-empty string is required to construct the adapter; if the env var is
  // unset the AppKit modal isn't created (see lib/appkit.ts) and the connect
  // button falls back to injected wallets, so this placeholder is never used to
  // actually reach the WalletConnect relay.
  projectId: projectId || "ballast-no-projectid",
  ssr: true,
  transports: { [robinhoodChain.id]: RPC_TRANSPORT },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
