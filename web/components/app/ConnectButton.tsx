"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { appKitEnabled } from "@/lib/wagmi";
import { shortAddress } from "@/lib/format";

// Opens the reown AppKit modal (multi-wallet picker, WalletConnect QR, mobile
// wallets). If no reown project id is configured, falls back to connecting the
// first injected (EIP-6963) wallet so local dev without a key still works.
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { open } = useAppKit();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => (appKitEnabled ? open({ view: "Account" }) : disconnect())}
        className="rounded-button border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
        title={appKitEnabled ? "Account" : "Disconnect"}
      >
        {shortAddress(address)}
      </button>
    );
  }

  const onConnect = () => {
    if (appKitEnabled) {
      open();
      return;
    }
    const injected = connectors[0];
    if (injected) connect({ connector: injected });
  };

  return (
    <button
      onClick={onConnect}
      disabled={isPending}
      className="rounded-button bg-green px-3.5 py-1.5 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-60"
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
