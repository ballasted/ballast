"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "@/components/app/nav-items";

// Plain bottom tab bar — below lg only (lg+ uses TopBar's nav row). Flush to
// the screen edge, never floating, never overlapping page content —
// AppLayout pads <main> by exactly this bar's height. Terminal and Analytics
// were removed from NAV_ITEMS entirely, so this is now 3 items; the rest
// (Buyback, Profile) live in AvatarMenu and the lg+ nav row, not squeezed in
// here.
const TAB_HREFS = ["/app/discover", "/app/portfolio", "/app/create"];
const TAB_ITEMS = TAB_HREFS.map((href) => NAV_ITEMS.find((item) => item.href === href)!);

export function BottomNav() {
  const pathname = usePathname();

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
    </nav>
  );
}
