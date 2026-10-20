// ─────────────────────────────────────────────────────────────────────────────
// Hidden tokens — the ONE canonical hide list for the whole product.
//
// A hidden token is a throwaway test/smoke launch that must never surface on any
// browsable surface (Discover grid, search, Top Movers, stat tiles, Portfolio
// holdings/launches, family/children counts, baskets, treasury aggregates, the
// Create page Parent picker, OG/share cards, the sitemap). It stays reachable by
// direct URL, where the token page renders a neutral "This token is hidden"
// notice instead of the live token UI.
//
// This module is intentionally framework-agnostic and dependency-free (only the
// viem `Address` type) so it can be imported from:
//   • the Next.js app (web/lib/contracts.ts re-exports from here)
//   • the Telegram bot (Phase 2, web/app/api/tg/*)
//   • the SDK (packages/sdk mirrors this list; a drift test keeps them identical)
//
// All entries are LOWERCASED for a case-insensitive compare. The env var
// NEXT_PUBLIC_HIDDEN_TOKEN_ADDRESSES EXTENDS (never replaces) this list, so a new
// disposable test token can be hidden with no code change.
// ─────────────────────────────────────────────────────────────────────────────
import type { Address } from "viem";

/** Smoke/test launches hidden in code. Correct default; the env var extends it. */
export const CODE_HIDDEN_TOKENS: Address[] = [
  "0x3fec2b548755d53fd8db97cac0c14dfa99f0e335", // gen-4 "TEST" factory probe
  "0x28c53790d77a23715972ae01ab7fa8430b31846f", // FeeRouter v2 smoke-test launch
];

/** Split a comma/space-separated address env var into lowercased addresses. */
export function parseHiddenList(v: string | undefined): Address[] {
  if (!v) return [];
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Address => /^0x[0-9a-f]{40}$/.test(s)) as Address[];
}

/** Code defaults + env extension, de-duplicated, lowercased. */
export const HIDDEN_TOKEN_ADDRESSES: Address[] = Array.from(
  new Set<string>([
    ...CODE_HIDDEN_TOKENS,
    ...parseHiddenList(process.env.NEXT_PUBLIC_HIDDEN_TOKEN_ADDRESSES),
  ]),
) as Address[];

/** True if `token` is on the hide list (case-insensitive). */
export function isHiddenToken(token: Address | string | undefined | null): boolean {
  if (!token) return false;
  const t = token.toLowerCase();
  return HIDDEN_TOKEN_ADDRESSES.some((a) => a.toLowerCase() === t);
}

/** Neutral copy for the direct-URL hidden-token page. No ticker, no claims. */
export const HIDDEN_TOKEN_NOTICE =
  "This token is hidden. It was a test launch and is not listed.";
