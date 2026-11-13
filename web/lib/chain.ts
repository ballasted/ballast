// This module USED to hardcode Robinhood Chain 4663. It is now a thin re-export of
// the active chain profile (lib/chainProfile.ts), which selects the chain at build
// time from NEXT_PUBLIC_CHAIN (robinhood | elysium). Kept as the stable import path
// every hook/component already uses (`activeChain`, `robinhoodChain`, PUBLIC_RPC_URL).
//
// Robinhood stays the default — an unset NEXT_PUBLIC_CHAIN behaves exactly as before.
import { activeChain, robinhoodChain, elysiumChain, profile } from "./chainProfile";

export { activeChain, robinhoodChain, elysiumChain, profile };
export { isElysium, isRobinhood, CHAIN_KEY } from "./chainProfile";
export type { ChainProfile, ChainKey, ChainFeatures } from "./chainProfile";

// The absolute, wallet-reachable RPC for the active chain. Two jobs: it's what
// wallet_addEthereumChain hands the wallet (which must reach it directly) and it's
// the client transport's fallback. The app's OWN reads still go through /api/rpc.
export const PUBLIC_RPC_URL = profile.publicRpcUrl;

// `robinhoodMainnet` alias kept for back-compat with older imports. It resolves to
// the ACTIVE chain (not necessarily Robinhood) so callers targeting "the chain this
// app runs on" keep working on both deployments.
export const robinhoodMainnet = activeChain;
