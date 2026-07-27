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
    <div
      className={cn(
        "flex items-center justify-center gap-2 rounded-input border border-border bg-bg px-3 py-1.5 text-xs",
        className,
      )}
      title={address}
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-green" aria-hidden />
      <span className="text-text-faint">{label}</span>
      <span className="font-mono font-medium text-text-primary">{shortAddress(address)}</span>
    </div>
  );
}
