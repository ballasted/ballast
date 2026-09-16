"use client";

import { useAccount } from "wagmi";
import { Wordmark } from "@/components/Wordmark";
import { ConnectButton } from "@/components/app/ConnectButton";
import { CommandSearch } from "@/components/app/CommandSearch";
import { NetworkChip } from "@/components/app/NetworkChip";
import { PortfolioValueChip } from "@/components/app/PortfolioValueChip";
import { AvatarMenu } from "@/components/app/AvatarMenu";

// App shell top bar (spec §4). Two variants in one component so there's one
// source of truth for what goes in it:
//  - Desktop (lg+): sits above the content column, beside the fixed SideNav
//    (which already carries the wordmark). Full set: search, network,
//    portfolio value, account.
//  - Mobile (<lg): the wordmark moves here (SideNav is hidden), and the
//    network chip / portfolio chip are dropped rather than crammed into 390px
//    — NetworkGuard's full-width banner already covers the wrong-network case,
//    and portfolio value has its own page.
export function TopBar() {
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
        <div className="mx-auto flex h-16 max-w-content items-center justify-between px-10">
          <CommandSearch />
          <div className="flex items-center gap-3">
            <NetworkChip />
            <PortfolioValueChip />
            {isConnected ? <AvatarMenu /> : <ConnectButton />}
          </div>
        </div>
      </header>
    </>
  );
}
