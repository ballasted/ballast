// Project listing metadata now lives on-chain: BallastToken.metadataURI points to
// a pinned JSON (name, description, category, logo, website, x). The launch version
// is permanent (launchMetadataURI) and updates are logged (MetadataUpdated), so the
// binding is immutable-by-default and fully auditable — no browser/DB store needed.
// This module keeps only the small shared pieces the create flow + cards use.

export const CATEGORIES = ["Index", "Treasury", "Meme", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

// Deterministic accent colour from the ticker, so every project has a stable
// identity even without an uploaded logo (used by the initials fallback mark).
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 42%)`;
}
