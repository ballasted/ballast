"use client";

import { useAccount, useBalance } from "wagmi";
import { formatEther } from "viem";
import { activeChain } from "@/lib/chain";
import { cn } from "@/lib/cn";

// The connected wallet's native ETH balance, read through OUR wagmi transport
// (the /api/rpc proxy → public fallback), NOT reown's account modal — reown reads
// balance from its own blockchain API, which doesn't know chain 4663 and returns
// 0.000 even when the wallet holds ETH. This is the balance the app trusts, shown
// before someone starts a launch so a zero shows up here first. Distinguishes
// loading / unavailable (read failed) / real value — never a silent zero.
export function WalletBalance({ className }: { className?: string }) {
  const { address, isConnected } = useAccount();
  const { data, isLoading, isError } = useBalance({
    address,
    chainId: activeChain.id,
    query: { enabled: isConnected && Boolean(address), refetchInterval: 15_000 },
  });

  if (!isConnected) return null;

  let text: string;
  let tone = "text-text-muted";
  if (isLoading) {
    text = "· · ·";
  } else if (isError || !data) {
    text = "balance unavailable";
    tone = "text-warning";
  } else {
    const eth = Number(formatEther(data.value));
    text = `${eth.toLocaleString("en", { maximumFractionDigits: 4 })} ETH`;
    if (eth === 0) tone = "text-warning";
  }

  return (
    <span
      className={cn("hidden tabular-nums text-xs sm:inline", tone, className)}
      title="Native ETH balance, read through the app's own RPC transport"
    >
      {text}
    </span>
  );
}
