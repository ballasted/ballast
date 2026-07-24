"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { appKitEnabled } from "@/lib/wagmi";
import { shortAddress } from "@/lib/format";

// Opens the reown AppKit modal, imported DYNAMICALLY on click so the wallet-picker
// UI isn't in the initial /app bundle. Account state comes from wagmi (the eager
// adapter), so a connected/reconnecting user never triggers the modal chunk. Falls
// back to injected (EIP-6963) discovery when no reown project id is configured.
async function openModal(view?: "Account") {
  const { modal } = await import("@/lib/appkit");
  modal?.open(view ? { view } : undefined);
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [busy, setBusy] = useState(false);

  if (isConnected && address) {
    return (
      <button
        onClick={() => (appKitEnabled ? void openModal("Account") : disconnect())}
        className="rounded-button border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
        title={appKitEnabled ? "Account" : "Disconnect"}
      >
        {shortAddress(address)}
      </button>
    );
  }

  const onConnect = async () => {
    if (appKitEnabled) {
      setBusy(true);
      try {
        await openModal();
      } finally {
        setBusy(false);
      }
      return;
    }
    const injected = connectors[0];
    if (injected) connect({ connector: injected });
  };

  return (
    <button
      onClick={() => void onConnect()}
      disabled={isPending || busy}
      className="rounded-button bg-green px-3.5 py-1.5 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-60"
    >
      {isPending || busy ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
