"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shortAddress } from "@/lib/format";

// Uses wagmi's EIP-6963 injected discovery (no connectors barrel import). If more
// than one wallet is present we connect the first discovered; a full picker can
// come later.
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="rounded-button border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
        title="Disconnect"
      >
        {shortAddress(address)}
      </button>
    );
  }

  const connector = connectors[0];

  if (!connector) {
    return (
      <span className="rounded-button border border-border px-3 py-1.5 text-sm text-text-muted">
        No wallet found
      </span>
    );
  }

  return (
    <button
      onClick={() => connect({ connector })}
      disabled={isPending}
      className="rounded-button bg-green px-3.5 py-1.5 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-60"
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
