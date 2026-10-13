"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS, TAB_HREFS, moreNavItems } from "@/components/app/nav-items";
import { useMoreMenu } from "@/components/app/MoreMenu";

// Mobile bottom tab bar — below lg only (lg+ uses TopBar's nav row). Flush to
// the screen edge; AppLayout pads <main> by exactly this bar's height. Four
// slots: the three fixed tabs (Discover, Create, Portfolio) plus a "More"
// button that opens the shared sheet (MoreMenu) holding every other route —
// Backing, Treasury, Baskets, Buyback, Profile — so nothing is unreachable on
// mobile the way it was when this bar was the ONLY nav and listed just three.
const TAB_ITEMS = TAB_HREFS.map((href) => NAV_ITEMS.find((item) => item.href === href)!);

export function BottomNav() {
  const pathname = usePathname();
  const { open } = useMoreMenu();

  // "More" reads as active whenever the current route is one of the items that
  // live inside its sheet rather than on the bar itself.
  const moreActive = moreNavItems(NAV_ITEMS).some((item) => pathname.startsWith(item.href));

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-bg pb-[env(safe-area-inset-bottom)] lg:hidden">
      {TAB_ITEMS.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors",
              active ? "text-green" : "text-text-muted",
            )}
          >
            <item.icon active={active} />
            {item.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-current={moreActive ? "page" : undefined}
        className={cn(
          "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors",
          moreActive ? "text-green" : "text-text-muted",
        )}
      >
        <IconMore active={moreActive} />
        More
      </button>
    </nav>
  );
}

function IconMore({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
      {active && <rect x="3" y="4" width="18" height="16" rx="4" stroke="currentColor" strokeWidth="1.3" opacity="0.5" />}
    </svg>
  );
}
