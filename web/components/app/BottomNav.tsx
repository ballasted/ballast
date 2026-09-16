"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "@/components/app/nav-items";

// Mobile / small-screen navigation. On desktop (lg+) TopBar's horizontal nav (or
// the terminal rail) replaces this, so it's hidden there. Items come from the
// shared NAV_ITEMS list.
//
// Seven items don't fit at 360px, so below md this shows only the 4 most-used
// (Discover, Terminal, Portfolio, Create) plus a "More" button revealing the
// rest (Analytics, Buyback, Profile) in a small popover — not wallet-gated, so
// it works whether or not a wallet is connected. At md and up (still <lg,
// tablet portrait) there's room for all 7 in one row.
const PRIMARY_HREFS = new Set(["/app/discover", "/app/terminal", "/app/portfolio", "/app/create"]);

export function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const primary = NAV_ITEMS.filter((item) => PRIMARY_HREFS.has(item.href));
  const overflow = NAV_ITEMS.filter((item) => !PRIMARY_HREFS.has(item.href));
  const overflowActive = overflow.some((item) => pathname.startsWith(item.href));

  return (
    <nav
      ref={rootRef}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      {moreOpen && (
        <div
          role="menu"
          className="card-raised absolute bottom-full right-2 mb-2 w-44 overflow-hidden p-1.5 md:hidden"
        >
          {overflow.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                onClick={() => setMoreOpen(false)}
                className={cn(
                  "flex min-h-[44px] items-center gap-2.5 rounded-input px-3 py-2 text-sm transition-colors",
                  active ? "text-green" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
                )}
              >
                <item.icon active={active} />
                {item.label}
              </Link>
            );
          })}
        </div>
      )}

      {/* Below md: 4 primary + More. */}
      <div className="flex items-stretch justify-around px-2 md:hidden">
        {primary.map((item) => (
          <NavTab key={item.href} href={item.href} label={item.label} Icon={item.icon} active={pathname.startsWith(item.href)} />
        ))}
        <button
          onClick={() => setMoreOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          className={cn(
            "flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[11px]",
            moreOpen || overflowActive ? "text-green" : "text-text-muted hover:text-text-secondary",
          )}
        >
          <MoreIcon />
          More
        </button>
      </div>

      {/* md and up (tablet, still below lg): all 7 fit in one row. */}
      <div className="hidden items-stretch justify-around px-4 md:flex">
        {NAV_ITEMS.map((item) => (
          <NavTab key={item.href} href={item.href} label={item.label} Icon={item.icon} active={pathname.startsWith(item.href)} />
        ))}
      </div>
    </nav>
  );
}

function NavTab({
  href,
  label,
  Icon,
  active,
}: {
  href: string;
  label: string;
  Icon: (props: { active: boolean }) => React.ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[11px]",
        active ? "text-green" : "text-text-muted hover:text-text-secondary",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon active={active} />
      {label}
    </Link>
  );
}

function MoreIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}
