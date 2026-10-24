"use client";

import { useAccount } from "wagmi";
import { Wordmark } from "@/components/Wordmark";
import { ConnectButton } from "@/components/app/ConnectButton";
import { CommandSearch } from "@/components/app/CommandSearch";
import { AvatarMenu } from "@/components/app/AvatarMenu";

// Mobile-only app header (below lg): logo on the left, search + wallet on the
// right. Primary navigation on mobile is BottomNav; on desktop the left icon
// rail (SideNav) owns everything, so this header is hidden at lg+ entirely —
// there is no desktop top bar anymore.
export function TopBar() {
  const { isConnected } = useAccount();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur lg:hidden">
      <div className="flex h-14 items-center justify-between gap-3 px-4">
        <Wordmark />
        <div className="flex items-center gap-2">
          <CommandSearch />
          {isConnected ? <AvatarMenu /> : <ConnectButton />}
        </div>
      </div>
    </header>
  );
}
