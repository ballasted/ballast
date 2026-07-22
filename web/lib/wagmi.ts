import { createConfig, http } from "wagmi";
import { robinhoodMainnet, robinhoodTestnet } from "./chain";

// Wagmi config lives here and is imported ONLY by the /app provider, so no web3
// code is pulled into the marketing bundle.
//
// We deliberately do NOT import from `wagmi/connectors`: that barrel eagerly
// pulls the MetaMask / WalletConnect / Base connectors and their optional native
// deps. Instead we rely on `multiInjectedProviderDiscovery` (default: true),
// which surfaces every injected wallet via EIP-6963 in `useConnect()`.
//
// Both chains are configured with concrete transports; reads pass an explicit
// chainId so they always hit the active network. The public RPC is rate-limited,
// so transports batch into multicall.
export const wagmiConfig = createConfig({
  chains: [robinhoodMainnet, robinhoodTestnet],
  transports: {
    [robinhoodMainnet.id]: http(undefined, { batch: true }),
    [robinhoodTestnet.id]: http(undefined, { batch: true }),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
