"use client";

import { useNetworkGuard } from "@/hooks/useNetworkGuard";

// App-wide wrong-network banner. Rendered in the app layout so it appears the
// moment a wallet connects on the wrong chain — not after a form is filled and
// signed. When the wallet is on the wrong network, this is the only call to
// action; every write button elsewhere is disabled with the reason on it.
export function NetworkGuard() {
  const { wrongNetwork, switchToRobinhood, isSwitching, error, targetChain } =
    useNetworkGuard();

  if (!wrongNetwork) return null;

  return (
    <div className="border-b border-warning-border bg-warning-bg">
      <div className="mx-auto flex max-w-content flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-warning">
          <span className="font-semibold">Wrong network.</span>{" "}
          <span className="text-text-secondary">
            BALLAST runs only on {targetChain.name}. Switch to continue —
            transactions are disabled until you do.
          </span>
          {error && <span className="mt-1 block text-negative">{error}</span>}
        </div>
        <button
          onClick={() => void switchToRobinhood()}
          disabled={isSwitching}
          className="btn-primary shrink-0 px-4 py-1.5 text-sm disabled:opacity-60"
        >
          {isSwitching ? "Switching…" : `Switch to ${targetChain.name}`}
        </button>
      </div>
    </div>
  );
}
