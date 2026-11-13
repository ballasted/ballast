"use client";

import { useCallback, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { activeChain } from "@/lib/chain";

// The chain this build targets (robinhood | elysium). Local alias kept so the body
// below reads the same as before; it is NOT necessarily Robinhood anymore.
const targetNetwork = activeChain;

// Single source of truth for "is the connected wallet on the network we support".
// Read on every render from the live account so a mid-session network change is
// caught immediately. Every write action must consult `wrongNetwork` and refuse
// to build a transaction while it is true — a wrong-network signature is how the
// original launch failure happened.
export function useNetworkGuard() {
  const { isConnected, chainId, connector } = useAccount();
  const { switchChainAsync, isPending } = useSwitchChain();
  const [error, setError] = useState<string | undefined>();

  const wrongNetwork = isConnected && chainId !== targetNetwork.id;

  const switchToActive = useCallback(async () => {
    setError(undefined);
    try {
      // wagmi asks the wallet to switch; most injected wallets add-then-switch
      // on a 4902 (unknown chain) automatically.
      await switchChainAsync({ chainId: targetNetwork.id });
    } catch (switchErr) {
      // Explicit fallback for wallets that do NOT auto-add: add the chain from our
      // canonical viem definition, then switch. Uses the raw provider so the params
      // exactly match lib/chainProfile.ts (no second, drifting source of RPC/explorer
      // URLs). On Elysium this hands the wallet a DIRECT RPC, never the HyperEVM inbox.
      try {
        const provider = (await connector?.getProvider()) as
          | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
          | undefined;
        if (!provider) throw switchErr;
        const hexId = `0x${targetNetwork.id.toString(16)}`;
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexId,
              chainName: targetNetwork.name,
              nativeCurrency: targetNetwork.nativeCurrency,
              rpcUrls: [...targetNetwork.rpcUrls.default.http],
              blockExplorerUrls: [targetNetwork.blockExplorers?.default.url],
            },
          ],
        });
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexId }],
        });
      } catch (addErr) {
        const raw = addErr instanceof Error ? addErr.message : String(addErr);
        if (/rejected|denied/i.test(raw)) {
          setError("You declined the network switch.");
        } else {
          setError((raw.split("\n")[0] ?? "Could not switch network.").slice(0, 160));
        }
      }
    }
  }, [switchChainAsync, connector]);

  return {
    isConnected,
    chainId,
    wrongNetwork,
    switchToActive,
    // Back-compat alias — many components call `switchToRobinhood`; it now switches
    // to whichever chain this build targets.
    switchToRobinhood: switchToActive,
    isSwitching: isPending,
    error,
    targetChain: targetNetwork,
    targetChainName: targetNetwork.name,
  };
}
