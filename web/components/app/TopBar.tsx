"use client";

import { useAccount } from "wagmi";
import { Wordmark } from "@/components/Wordmark";
import { ConnectButton } from "@/components/app/ConnectButton";
import { CommandSearch } from "@/components/app/CommandSearch";
import { NetworkChip } from "@/components/app/NetworkChip";
import { PortfolioValueChip } from "@/components/app/PortfolioValueChip";
import { AvatarMenu } from "@/components/app/AvatarMenu";

// App shell top bar — logo, search, and account only. Navigation lives
// entirely in BottomNav's floating pill now (every breakpoint, not just
// mobile — see BottomNav.tsx), so this stays the same minimal bar everywhere
// instead of growing a second horizontal link row on desktop. `hasRail` (true
// only on /app/terminal) no longer changes anything HERE — kept as a prop
// since AppLayout still passes it, harmless if unused by a future variant.
export function TopBar({ hasRail: _hasRail = false }: { hasRail?: boolean }) {
  const { isConnected } = useAccount();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-content items-center justify-between gap-3 px-6 lg:h-16 lg:px-10">
        <Wordmark />
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
