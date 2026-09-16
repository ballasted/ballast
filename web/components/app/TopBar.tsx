"use client";

import { useAccount } from "wagmi";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";
import { ConnectButton } from "@/components/app/ConnectButton";
import { CommandSearch } from "@/components/app/CommandSearch";
import { NetworkChip } from "@/components/app/NetworkChip";
import { PortfolioValueChip } from "@/components/app/PortfolioValueChip";
import { AvatarMenu } from "@/components/app/AvatarMenu";
import { NAV_ITEMS } from "@/components/app/nav-items";
import { cn } from "@/lib/cn";

// App shell top bar. Two variants in one component so there's one source of
// truth for what goes in it:
//  - Mobile (<lg): wordmark + search + account. BottomNav covers navigation.
//  - Desktop (lg+): wordmark, horizontal primary nav (underline active state,
//    hidden on /app/terminal — the surviving rail there covers nav instead so
//    the two never show at once), then search / network / portfolio / account.
//
// `hasRail` is true only on /app/terminal, where SideNav still renders.
export function TopBar({ hasRail = false }: { hasRail?: boolean }) {
  const { isConnected } = useAccount();

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur lg:hidden">
        <div className="mx-auto flex h-14 max-w-content items-center justify-between px-6">
          <Wordmark />
          <div className="flex items-center gap-2">
            <CommandSearch />
            {isConnected ? <AvatarMenu /> : <ConnectButton />}
          </div>
        </div>
      </header>

      <header className="sticky top-0 z-30 hidden border-b border-border bg-bg/85 backdrop-blur lg:block">
        <div className="mx-auto flex h-16 max-w-content items-center gap-6 px-10">
          <Wordmark />
          {!hasRail && <DesktopNav />}
          <div className="flex flex-1 items-center justify-end gap-3">
            <CommandSearch />
            <NetworkChip />
            <PortfolioValueChip />
            {isConnected ? <AvatarMenu /> : <ConnectButton />}
          </div>
        </div>
      </header>
    </>
  );
}

function DesktopNav() {
  const pathname = usePathname();
  return (
    <nav className="flex h-full items-center gap-5">
      {NAV_ITEMS.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-full items-center border-b-2 text-sm font-medium transition-colors",
              active
                ? "border-green text-green"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
