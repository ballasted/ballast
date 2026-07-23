import type { Address } from "viem";

// BallastFactory.launch() persists only name, symbol, and noticePeriod on-chain.
// Category, description, and logo are listing metadata with no on-chain slot and
// no shared backend wired yet, so we persist them in the browser keyed by token
// address. This is a REAL store (survives reloads on this device), not a stub —
// but it is device-local. A shared metadata service (DATABASE_URL) will replace
// this without changing the read/write shape below.

export type ProjectMeta = {
  category: string;
  description: string;
  logoUrl?: string;
  color?: string;
};

const KEY = (token: Address) => `ballast:meta:${token.toLowerCase()}`;

export function saveMeta(token: Address, meta: ProjectMeta): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY(token), JSON.stringify(meta));
  } catch {
    // Storage full / disabled — the launch itself is unaffected; metadata is
    // best-effort until the backend exists.
  }
}

export function loadMeta(token: Address): ProjectMeta | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(KEY(token));
    return raw ? (JSON.parse(raw) as ProjectMeta) : undefined;
  } catch {
    return undefined;
  }
}

export const CATEGORIES = ["Index", "Treasury", "Meme", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

// Deterministic accent colour from the ticker, so every project has a stable
// identity even without an uploaded logo.
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 42%)`;
}
