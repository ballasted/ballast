"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { appKitEnabled } from "@/lib/wagmi";
import { shortAddress } from "@/lib/format";
import { RailTooltip } from "@/components/app/nav-items";

// Opens the reown AppKit modal, imported DYNAMICALLY on click so the wallet-picker
// UI isn't in the initial /app bundle. Account state comes from wagmi (the eager
// adapter), so a connected/reconnecting user never triggers the modal chunk. Falls
// back to injected (EIP-6963) discovery when no reown project id is configured.
async function openModal(view?: "Account") {
  const { modal } = await import("@/lib/appkit");
  modal?.open(view ? { view } : undefined);
}

export function ConnectButton({ compact = false }: { compact?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [busy, setBusy] = useState(false);

  if (isConnected && address) {
    if (compact) {
      return (
        <button
          onClick={() => (appKitEnabled ? void openModal("Account") : disconnect())}
          className="group relative flex h-11 w-11 items-center justify-center rounded-input text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          aria-label={appKitEnabled ? "Account" : "Disconnect"}
        >
          <IconWallet />
          <RailTooltip label={shortAddress(address)} />
        </button>
      );
    }
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

  if (compact) {
    return (
      <button
        onClick={() => void onConnect()}
        disabled={isPending || busy}
        className="group relative flex h-11 w-11 items-center justify-center rounded-input bg-green text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
        aria-label={isPending || busy ? "Connecting…" : "Connect wallet"}
      >
        <IconWallet />
        <RailTooltip label={isPending || busy ? "Connecting…" : "Connect wallet"} />
      </button>
    );
  }

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

function IconWallet() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="6" width="18" height="13" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 10h18" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16.5" cy="14.5" r="1.3" fill="currentColor" />
    </svg>
  );
}
