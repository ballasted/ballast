"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, useDisconnect } from "wagmi";
import { AssetDisc } from "@/components/app/AssetDisc";
import { useBlurBalances } from "@/hooks/useBlurBalances";
import { useDensity } from "@/hooks/useDensity";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

// Connected-wallet menu (spec §4, App shell). Replaces ConnectButton once
// connected. "Transfers" from the spec's menu is omitted — there's no
// transfer-history data source anywhere in this app (no indexer), and a menu
// item that goes nowhere is worse than one that doesn't exist. "Settings" is
// folded into this menu directly (blur balances, density) rather than a link
// to a settings page that would otherwise be empty.
export function AvatarMenu() {
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const { blurred, toggle: toggleBlur } = useBlurBalances();
  const { density, setDensity } = useDensity();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!address) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-pill border border-border bg-card px-2 py-1.5 pr-3 text-sm text-text-secondary transition-colors hover:border-border-strong"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <AssetDisc symbol={address.slice(2, 4)} size={24} />
        {shortAddress(address)}
      </button>

      {open && (
        <div
          role="menu"
          className="card-raised absolute right-0 top-[calc(100%+8px)] z-50 w-64 overflow-hidden p-1.5"
        >
          <MenuLink href="/app/profile" onClick={() => setOpen(false)}>
            Your profile
          </MenuLink>
          <MenuLink href="/app/portfolio" onClick={() => setOpen(false)}>
            Positions
          </MenuLink>

          <div className="my-1.5 border-t border-border" />

          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm text-text-secondary">Blur balances</span>
            <Switch checked={blurred} onChange={toggleBlur} label="Blur balances" />
          </div>

          <div className="px-3 py-2">
            <span className="mb-1.5 block text-sm text-text-secondary">Density</span>
            <div className="flex gap-1.5">
              {(["comfortable", "compact"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDensity(d)}
                  className={cn("tab-segment flex-1 border", density === d ? "tab-active" : "tab-idle")}
                >
                  {d === "comfortable" ? "Comfortable" : "Compact"}
                </button>
              ))}
            </div>
          </div>

          <div className="my-1.5 border-t border-border" />

          <button
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
            role="menuitem"
            className="block w-full rounded-input px-3 py-2 text-left text-sm text-negative transition-colors hover:bg-surface-hover"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function MenuLink({ href, onClick, children }: { href: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      role="menuitem"
      className="block rounded-input px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
    >
      {children}
    </Link>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-pill border transition-colors",
        checked ? "border-green bg-green/30" : "border-border bg-bg",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-bone transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
