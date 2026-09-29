// Central config for every EXTERNAL link BALLAST points at. Both trees (marketing
// root + /app) and the docs import from here, so a handle change is a one-line edit.
//
// Pure string constants — NO web3, NO React. Safe to import into the marketing tree
// (root layout, footer, docs) without dragging the wallet bundle in (CLAUDE.md §8).
//
// ⚠️ Telegram: collapsed to a SINGLE link per an explicit 2026-09-29 instruction
// (TELEGRAM_URL = t.me/ballastedotfun), overwriting a DIFFERENT, previously-verified
// two-link setup (confirmed 2026-07-30 by fetching the live t.me pages: Announcements
// = t.me/ballastedapp read-only channel, Discussion = t.me/launchballast open group).
// If that July verification still holds, t.me/ballastedotfun is very likely a typo/
// wrong handle — re-verify before shipping. Flagged, not silently resolved.

export const X_URL = "https://x.com/ballastedapp";
export const X_HANDLE = "@ballastedapp"; // for the Twitter card `site`

export const TELEGRAM_URL = "https://t.me/ballastedotfun";

export const DOCS_PATH = "/docs"; // internal route

// GitHub is only listed once the repo is public. Set this to the repo URL then and
// it appears automatically in the footer + JSON-LD; left undefined it's omitted.
export const GITHUB_URL: string | undefined = undefined;

/** External profiles for JSON-LD `sameAs` (external URLs only — not internal docs). */
export const SAME_AS: string[] = [
  X_URL,
  TELEGRAM_URL,
  ...(GITHUB_URL ? [GITHUB_URL] : []),
];

export type IconName = "x" | "telegram" | "docs" | "github" | "website";
export type SiteLink = { label: string; href: string; icon: IconName; external: boolean };

/**
 * The community/social row shared by the marketing footer, the app, and the docs.
 * Exactly one X link and one Telegram link — see the TELEGRAM_URL note above.
 */
export const COMMUNITY_LINKS: SiteLink[] = [
  { label: "X", href: X_URL, icon: "x", external: true },
  { label: "Telegram", href: TELEGRAM_URL, icon: "telegram", external: true },
  { label: "Docs", href: DOCS_PATH, icon: "docs", external: false },
  ...(GITHUB_URL ? [{ label: "GitHub", href: GITHUB_URL, icon: "github" as const, external: true }] : []),
];
