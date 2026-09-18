"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { Wordmark } from "@/components/Wordmark";
import { ConnectButton } from "@/components/app/ConnectButton";
import { CommandSearch } from "@/components/app/CommandSearch";
import { NetworkChip } from "@/components/app/NetworkChip";
import { PortfolioValueChip } from "@/components/app/PortfolioValueChip";
import { AvatarMenu } from "@/components/app/AvatarMenu";
import { NAV_ITEMS } from "@/components/app/nav-items";
import { cn } from "@/lib/cn";

// App shell top bar — logo, nav, search, and account. `hasRail` (true only on
// /app/terminal) hides this bar's own nav row since SideNav already carries
// the full list there — nav must never show twice on the same screen. Below
// lg, BottomNav is the only nav; this bar's nav row is lg+ only.
export function TopBar({ hasRail = false }: { hasRail?: boolean }) {
  const { isConnected } = useAccount();
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-content items-center justify-between gap-3 px-6 lg:h-16 lg:px-10">
        <div className="flex items-center gap-7">
          <Wordmark />
          {!hasRail && (
            <nav className="hidden items-center gap-5 lg:flex">
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "text-sm font-medium transition-colors",
                      active ? "text-text-primary" : "text-text-muted hover:text-text-secondary",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          )}
        </div>
        <div className="flex items-center gap-2 lg:gap-3">
          <CommandSearch />
          <span className="hidden lg:contents">
            <NetworkChip />
            <PortfolioValueChip />
          </span>
          {isConnected ? <AvatarMenu /> : <ConnectButton />}
        </div>
      </div>
    </header>
  );
}
