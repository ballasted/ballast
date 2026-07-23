import { createConfig, http } from "wagmi";
import { robinhoodChain } from "./chain";

// Wagmi config lives here and is imported ONLY by the /app provider, so no web3
// code is pulled into the marketing bundle.
//
// We deliberately do NOT import from `wagmi/connectors`: that barrel eagerly
// pulls the MetaMask / WalletConnect / Base connectors and their optional native
// deps. Instead we rely on `multiInjectedProviderDiscovery` (default: true),
// which surfaces every injected wallet via EIP-6963 in `useConnect()`.
//
// Robinhood Chain (4663) is the ONLY chain listed. We support no other network;
// listing a second chain is what made wagmi report a connected wallet as being on
// the wrong network (see lib/chain.ts). The public RPC is rate-limited, so the
// transport batches into multicall.
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  transports: {
    [robinhoodChain.id]: http(undefined, { batch: true }),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
