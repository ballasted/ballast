"use client";

import { useAccount } from "wagmi";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

// A small, deliberately prominent indicator of WHICH wallet is about to act —
// placed next to the launch/swap buttons. On a chain where people juggle a
// deployer, a vault, and a personal wallet, "which address is signing this" must
// be obvious at the moment of action, not buried in a menu. Shows the full
// address in the tooltip; renders nothing until a wallet is connected.
export function ActingAs({ className, label = "Acting as" }: { className?: string; label?: string }) {
  const { address, isConnected } = useAccount();
  if (!isConnected || !address) return null;
  return (
    <div className={cn("flex items-center gap-1.5 text-xs text-text-faint", className)} title={address}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green/80" aria-hidden />
      <span>{label}</span>
      <span className="font-mono text-text-secondary">{shortAddress(address)}</span>
    </div>
  );
}
