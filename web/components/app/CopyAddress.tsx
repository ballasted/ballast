"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

// Address + real copy-to-clipboard, used on the wallet-scoped identity headers
// (Portfolio, Profile). Uses the actual Clipboard API and reports the outcome
// truthfully — a `catch` (e.g. a non-secure context) shows "Copy failed", not
// a fake "Copied" swap.
export function CopyAddress({ address, label, className }: { address: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setState("copied");
    } catch {
      setState("failed");
    } finally {
      setTimeout(() => setState("idle"), 1600);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn("group flex items-center gap-1.5 font-mono text-xs text-text-muted transition-colors hover:text-text-secondary", className)}
      title={address}
    >
      {label}
      <IconCopy className={cn("shrink-0", state === "copied" && "text-green", state === "failed" && "text-negative")} />
      <span className="sr-only">Copy address</span>
      {state !== "idle" && <span className={state === "copied" ? "text-green" : "text-negative"}>{state === "copied" ? "Copied" : "Copy failed"}</span>}
    </button>
  );
}

function IconCopy({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
