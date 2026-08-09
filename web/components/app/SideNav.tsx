"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "@/components/app/nav-items";
import { Wordmark } from "@/components/Wordmark";
import { WalletBalance } from "@/components/app/WalletBalance";
import { ConnectButton } from "@/components/app/ConnectButton";

// Desktop navigation — a fixed left rail (lg+ only; the BottomNav covers mobile).
// Brand lockup at top, primary nav in the middle, wallet at the bottom, so the
// laptop layout stops using a phone's bottom bar. Renders from the shared NAV_ITEMS.
export function SideNav() {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border bg-bg/70 backdrop-blur lg:flex">
      <div className="px-5 py-5">
        <Wordmark />
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-input px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-surface-hover text-green"
                  : "text-text-muted hover:bg-surface-raised hover:text-text-secondary",
              )}
            >
              <Icon active={active} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-border p-3">
        <WalletBalance className="px-1 text-xs text-text-muted" />
        <ConnectButton />
      </div>
    </aside>
  );
}
