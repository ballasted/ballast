// Central config for every EXTERNAL link BALLAST points at. Both trees (marketing
// root + /app) and the docs import from here, so a handle change is a one-line edit.
//
// Pure string constants — NO web3, NO React. Safe to import into the marketing tree
// (root layout, footer, docs) without dragging the wallet bundle in (CLAUDE.md §8).
//
// Telegram mapping confirmed 2026-07-30 by fetching the public t.me pages:
//   Announcements = t.me/ballastedapp is the read-only broadcast CHANNEL
//   Discussion    = t.me/launchballast is the open GROUP
// (the two were originally noted the other way round — corrected here).

export const X_URL = "https://x.com/ballastedapp";
export const X_HANDLE = "@ballastedapp"; // for the Twitter card `site`

export const TELEGRAM_ANNOUNCEMENTS_URL = "https://t.me/ballastedapp"; // read-only channel
export const TELEGRAM_DISCUSSION_URL = "https://t.me/launchballast"; // open group

export const DOCS_PATH = "/docs"; // internal route

// GitHub is only listed once the repo is public. Set this to the repo URL then and
// it appears automatically in the footer + JSON-LD; left undefined it's omitted.
export const GITHUB_URL: string | undefined = undefined;

/** External profiles for JSON-LD `sameAs` (external URLs only — not internal docs). */
export const SAME_AS: string[] = [
  X_URL,
  TELEGRAM_ANNOUNCEMENTS_URL,
  TELEGRAM_DISCUSSION_URL,
  ...(GITHUB_URL ? [GITHUB_URL] : []),
];

export type IconName = "x" | "telegram" | "docs" | "github" | "website";
export type SiteLink = { label: string; href: string; icon: IconName; external: boolean };

/**
 * The community/social row shared by the marketing footer, the app, and the docs.
 * The two Telegram entries are labelled DISTINCTLY so they don't read as two
 * identical icons to the same platform.
 */
export const COMMUNITY_LINKS: SiteLink[] = [
  { label: "X", href: X_URL, icon: "x", external: true },
  { label: "Telegram · Announcements", href: TELEGRAM_ANNOUNCEMENTS_URL, icon: "telegram", external: true },
  { label: "Telegram · Discussion", href: TELEGRAM_DISCUSSION_URL, icon: "telegram", external: true },
  { label: "Docs", href: DOCS_PATH, icon: "docs", external: false },
  ...(GITHUB_URL ? [{ label: "GitHub", href: GITHUB_URL, icon: "github" as const, external: true }] : []),
];
