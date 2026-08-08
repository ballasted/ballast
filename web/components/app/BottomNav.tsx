"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/app/discover", label: "Discover", icon: IconDiscover },
  { href: "/app/terminal", label: "Terminal", icon: IconTerminal },
  { href: "/app/analytics", label: "Analytics", icon: IconAnalytics },
  { href: "/app/buyback", label: "Buyback", icon: IconBurn },
  { href: "/app/create", label: "Create", icon: IconCreate },
  { href: "/app/portfolio", label: "Portfolio", icon: IconPortfolio },
  { href: "/app/profile", label: "Profile", icon: IconProfile },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-content items-stretch justify-around px-6 lg:px-12">
        {ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 py-2.5 text-xs",
                active ? "text-green" : "text-text-muted hover:text-text-secondary",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon active={active} />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function IconDiscover({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M15 9l-2 4-4 2 2-4 4-2z" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
function IconCreate() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconBurn({ active }: { active: boolean }) {
  // A flame outline — buyback-and-burn. Inline SVG, no icon library or emoji.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3c1 3-2 4-2 7a2 2 0 004 0c0-1 0-2-.5-3 2 1.5 3.5 4 3.5 6.5a5 5 0 11-10 0C7 10 10 7 12 3z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconTerminal({ active }: { active: boolean }) {
  // A console window: prompt chevron + input line. Fills faintly when active,
  // matching the other icons' active treatment.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="3"
        fill="currentColor"
        fillOpacity={active ? 0.15 : 0}
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M7 9.5l2.5 2.5L7 14.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconAnalytics({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 20V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect x="7.5" y="12" width="3" height="5" rx="1" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" />
      <rect x="13.5" y="8" width="3" height="9" rx="1" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function IconPortfolio() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 19V10m5 9V5m5 14v-7m5 7V8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconProfile() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
      <path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
