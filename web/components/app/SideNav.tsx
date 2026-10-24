"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { cn } from "@/lib/cn";
import {
  NAV_ITEMS,
  navGroups,
  RailTooltip,
  IconSettings,
  type NavItem,
} from "@/components/app/nav-items";
import { KeelMark } from "@/components/Wordmark";
import { CommandSearch } from "@/components/app/CommandSearch";
import { ConnectButton } from "@/components/app/ConnectButton";
import { AvatarMenu } from "@/components/app/AvatarMenu";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";

// Desktop primary navigation — a slim (72px) icon rail, present on EVERY /app
// route at lg+ (it replaced the old crowded top bar; TopBar is now a mobile-only
// header). Icons carry a hover label flyout + an aria-label, the active route gets
// a soft green pill, and the rail is grouped: a primary cluster (Discover,
// Analytics, Create, Portfolio) over a "Ballast" cluster (Backing, Treasury,
// Baskets, Buyback, Vote, Team split). Search opens the ⌘K palette; the bottom
// cluster is chain status, wallet (popover), and settings. Below lg this whole
// rail is hidden — BottomNav + the mobile TopBar own navigation there.
export function SideNav() {
  const pathname = usePathname();
  const { isConnected } = useAccount();
  const { primary, ballast, extra } = navGroups(NAV_ITEMS);
  // Profile lives in the bottom settings slot, not the scrolling list.
  const extraTop = extra.filter((i) => i.href !== "/app/profile");
  const hasProfile = extra.some((i) => i.href === "/app/profile");

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[72px] flex-col items-center border-r border-border bg-bg/80 py-4 backdrop-blur lg:flex">
      <Link
        href="/app/discover"
        aria-label="Ballast home"
        className="mb-1 flex h-11 w-11 items-center justify-center"
      >
        <KeelMark size={26} />
      </Link>

      <CommandSearch variant="icon" />

      <RailDivider />

      <nav className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden px-2">
        {primary.map((item) => (
          <RailLink key={item.href} item={item} pathname={pathname} />
        ))}
        {extraTop.map((item) => (
          <RailLink key={item.href} item={item} pathname={pathname} />
        ))}

        {ballast.length > 0 && <RailGroupLabel label="Ballast" />}
        {ballast.map((item) => (
          <RailLink key={item.href} item={item} pathname={pathname} />
        ))}
      </nav>

      <div className="mt-2 flex w-full flex-col items-center gap-1.5 border-t border-border pt-3">
        <RailChainStatus />
        {isConnected ? <AvatarMenu placement="rail" /> : <ConnectButton compact />}
        {hasProfile && (
          <Link
            href="/app/profile"
            aria-label="Settings"
            aria-current={pathname.startsWith("/app/profile") ? "page" : undefined}
            className={cn(
              "group relative flex h-11 w-11 items-center justify-center rounded-input transition-colors",
              pathname.startsWith("/app/profile")
                ? "bg-green-bg text-green"
                : "text-text-muted hover:bg-surface-raised hover:text-text-secondary",
            )}
          >
            <IconSettings active={pathname.startsWith("/app/profile")} />
            <RailTooltip label="Settings" />
          </Link>
        )}
      </div>
    </aside>
  );
}

function RailLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-11 w-11 items-center justify-center rounded-input transition-colors",
        active
          ? "bg-green-bg text-green"
          : "text-text-muted hover:bg-surface-raised hover:text-text-secondary",
      )}
    >
      <Icon active={active} />
      <RailTooltip label={item.label} />
    </Link>
  );
}

function RailDivider() {
  return <div className="my-2 h-px w-8 bg-border" />;
}

function RailGroupLabel({ label }: { label: string }) {
  return (
    <div className="mt-3 mb-1 flex w-full items-center justify-center" aria-hidden>
      <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-text-faint">{label}</span>
    </div>
  );
}

// Compact chain indicator for the rail bottom: a green dot on Robinhood Chain, an
// amber "switch" dot otherwise. Nothing while disconnected (the wallet control
// owns that state) — same rule as the top-bar NetworkChip.
function RailChainStatus() {
  const { isConnected, wrongNetwork, switchToRobinhood, isSwitching, targetChain } = useNetworkGuard();
  if (!isConnected) return null;
  if (wrongNetwork) {
    return (
      <button
        onClick={() => void switchToRobinhood()}
        disabled={isSwitching}
        aria-label={isSwitching ? "Switching network" : "Switch to Robinhood Chain"}
        className="group relative flex h-11 w-11 items-center justify-center rounded-input text-warning transition-colors hover:bg-surface-raised disabled:opacity-60"
      >
        <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />
        <RailTooltip label={isSwitching ? "Switching…" : "Switch network"} />
      </button>
    );
  }
  return (
    <span className="group relative flex h-11 w-11 items-center justify-center rounded-input" aria-label={`Connected to ${targetChain.name}`}>
      <span className="h-2 w-2 rounded-full bg-green" aria-hidden />
      <RailTooltip label={targetChain.name} />
    </span>
  );
}
