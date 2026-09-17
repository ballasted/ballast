"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "@/components/app/nav-items";

// Mobile / small-screen navigation. On desktop (lg+) TopBar's horizontal nav (or
// the terminal rail) replaces this, so it's hidden there. Items come from the
// shared NAV_ITEMS list — hrefs, labels, icons, and active-state logic are all
// untouched here; this file only changes how they're rendered (a floating pill
// instead of a flush full-width bar).
//
// Seven items don't fit at 360px, so below md this shows only the 4 most-used
// (Discover, Terminal, Portfolio, Create) plus a "More" button revealing the
// rest (Analytics, Buyback, Profile) in a small popover — not wallet-gated, so
// it works whether or not a wallet is connected. At md and up (still <lg,
// tablet portrait) there's room for all 7 in one row.
const PRIMARY_HREFS = new Set(["/app/discover", "/app/terminal", "/app/portfolio", "/app/create"]);

// The primary CTA — "launch a token" — gets a raised circular FAB treatment
// instead of sitting flush in the pill like the other icons.
const FAB_HREF = "/app/create";

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
      className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <div className="relative flex items-center gap-0.5 rounded-full border border-border bg-bg/80 px-2 py-1.5 shadow-lg shadow-black/30 backdrop-blur-md">
        {moreOpen && (
          <div
            role="menu"
            className="card-raised absolute bottom-full left-1/2 mb-3 w-44 -translate-x-1/2 overflow-hidden p-1.5 shadow-lg md:hidden"
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
        <div className="flex items-center gap-0.5 md:hidden">
          {primary.map((item) => (
            <NavTab
              key={item.href}
              href={item.href}
              label={item.label}
              Icon={item.icon}
              active={pathname.startsWith(item.href)}
              isFab={item.href === FAB_HREF}
            />
          ))}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            className={cn(
              "flex min-h-[44px] min-w-[52px] flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1.5 text-[11px] transition-colors",
              moreOpen || overflowActive ? "text-green" : "text-text-muted hover:text-text-secondary",
            )}
          >
            <MoreIcon />
            More
          </button>
        </div>

        {/* md and up (tablet, still below lg): all 7 fit in one row. */}
        <div className="hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => (
            <NavTab
              key={item.href}
              href={item.href}
              label={item.label}
              Icon={item.icon}
              active={pathname.startsWith(item.href)}
              isFab={item.href === FAB_HREF}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}

function NavTab({
  href,
  label,
  Icon,
  active,
  isFab,
}: {
  href: string;
  label: string;
  Icon: (props: { active: boolean }) => React.ReactNode;
  active: boolean;
  isFab?: boolean;
}) {
  if (isFab) {
    // Raised, larger, circular — proud of the pill rather than in-line with
    // the other icons, since this is the primary "launch a token" CTA. Static
    // treatment only (position, size, ring, shadow) — no pulsing/looping
    // animation, per this app's motion philosophy (globals.css "Motion").
    return (
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        title={label}
        className={cn(
          "-translate-y-4 flex h-16 w-16 shrink-0 items-center justify-center rounded-full border shadow-lg ring-4 ring-bg transition-colors",
          active
            ? "border-green bg-green text-bg"
            : "border-border bg-surface-raised text-text-primary hover:bg-surface-hover",
        )}
      >
        <span className="scale-125">
          <Icon active={active} />
        </span>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-[44px] min-w-[52px] flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1.5 text-[11px] transition-colors",
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
