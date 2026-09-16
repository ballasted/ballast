"use client";

import { useNetworkGuard } from "@/hooks/useNetworkGuard";

// Top-bar network indicator (spec §4, App shell): green dot when the
// connected wallet is on Robinhood Chain, amber "Switch network" when it
// isn't. Renders nothing while disconnected — ConnectButton owns that state.
export function NetworkChip() {
  const { isConnected, wrongNetwork, switchToRobinhood, isSwitching, targetChain } = useNetworkGuard();

  if (!isConnected) return null;

  if (wrongNetwork) {
    return (
      <button
        onClick={() => void switchToRobinhood()}
        disabled={isSwitching}
        className="chip chip-warning disabled:opacity-60"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
        {isSwitching ? "Switching…" : "Switch network"}
      </button>
    );
  }

  return (
    <span className="chip chip-neutral" title={`Connected to ${targetChain.name}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden />
      {targetChain.name}
    </span>
  );
}
