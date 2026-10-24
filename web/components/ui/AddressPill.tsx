"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { shortAddress } from "@/lib/format";
import { BLOCKSCOUT_URL } from "@/lib/blockscout";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "./icons";

/**
 * Short address + copy + explorer link (spec §1). Reuses `shortAddress`
 * (lib/format) and `BLOCKSCOUT_URL` (lib/blockscout) so the truncation and the
 * explorer base match the rest of the app. `label` overrides the shown text
 * (e.g. a known contract name) while copy/explorer still use the real address.
 */
export function AddressPill({
  address,
  label,
  prefix,
  explorer = true,
  className,
}: {
  address: string;
  label?: string;
  prefix?: string;
  explorer?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked (insecure context / denied) — no-op, the address is
      // still visible and the explorer link still works.
    }
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-chip border border-hairline bg-white/[0.02] px-2 py-0.5 text-ui-xs text-text-secondary",
        className,
      )}
    >
      {prefix ? <span className="text-text-muted">{prefix}</span> : null}
      <span className="font-mono">{label ?? shortAddress(address)}</span>
      <button
        type="button"
        onClick={copy}
        title="Copy address"
        aria-label="Copy address"
        className="text-text-muted transition-colors hover:text-text-primary"
      >
        {copied ? (
          <CheckIcon className="h-3.5 w-3.5 text-green" />
        ) : (
          <CopyIcon className="h-3.5 w-3.5" />
        )}
      </button>
      {explorer ? (
        <a
          href={`${BLOCKSCOUT_URL}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          title="View on explorer"
          aria-label="View on explorer"
          className="text-text-muted transition-colors hover:text-text-primary"
        >
          <ExternalLinkIcon className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </span>
  );
}
