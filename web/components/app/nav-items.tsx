import { V1_CLAIM_DEADLINE_UNIX, isV1ClaimConfigured } from "@/lib/contracts";

// Single source of truth for the app's primary navigation. Both the desktop
// SideNav and the mobile TopBar render from this list via `visibleNavItems`,
// so an entry (or its order) is defined once and can never drift between the
// two shells. BottomNav keeps its own curated subset (see its own comment)
// and is deliberately not wired to this — a time-limited promo entry has no
// business displacing one of its 3 primary tabs.

export type NavItem = {
  href: string;
  label: string;
  icon: (props: { active: boolean }) => React.ReactNode;
  /** Unix seconds. Item disappears from `visibleNavItems` once past this —
   *  for time-limited entries (e.g. a claim window), never a permanent one. */
  expiresAt?: number;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/app/discover", label: "Discover", icon: IconDiscover },
  { href: "/app/buyback", label: "Buyback", icon: IconBurn },
  { href: "/app/create", label: "Create", icon: IconCreate },
  { href: "/app/portfolio", label: "Portfolio", icon: IconPortfolio },
  { href: "/app/profile", label: "Profile", icon: IconProfile },
  // v1 -> v2 migration claim window — self-removing after deadline, and never
  // shown at all if the claim contract isn't live.
  ...(isV1ClaimConfigured
    ? [{ href: "/app/migrate", label: "Migrate", icon: IconMigrate, expiresAt: V1_CLAIM_DEADLINE_UNIX }]
    : []),
];

/** `NAV_ITEMS` filtered for right now — call this from render, not the raw
 *  array, wherever a time-limited entry should actually disappear on time. */
export function visibleNavItems(items: NavItem[] = NAV_ITEMS): NavItem[] {
  const nowSec = Date.now() / 1000;
  return items.filter((item) => item.expiresAt === undefined || nowSec < item.expiresAt);
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
function IconPortfolio() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 19V10m5 9V5m5 14v-7m5 7V8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconMigrate({ active }: { active: boolean }) {
  // Two arrows exchanging places — v1 -> v2.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 9h13M13 5l4 4-4 4M20 15H7m4 4l-4-4 4-4"
        stroke="currentColor"
        strokeWidth={active ? 2.25 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
