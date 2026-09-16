// Discover hero's secondary card content (spec §5.1) — a single config object
// so the campaign slot can change without touching component code or a
// redeploy of the surrounding layout. Edit this file and ship; no other file
// needs to change for a new campaign.
export type Campaign = {
  eyebrow: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
};

export const CURRENT_CAMPAIGN: Campaign = {
  eyebrow: "How it works",
  headline: "See what backs a token before you trade it.",
  body: "Every Ballast treasury reads on-chain — no wallet, no trust required.",
  ctaLabel: "How Ballast works",
  ctaHref: "/docs/how-ballast-works",
};
