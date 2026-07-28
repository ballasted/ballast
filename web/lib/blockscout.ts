// Blockscout REST API (v2) client types + helpers. Blockscout indexes every ERC-20
// Transfer on Robinhood Chain from block zero and exposes it over a free, key-less
// API, so it is a BETTER holders source than our own indexer would be (full
// history vs. starting at a deploy block). Public instances rate-limit ~10 rps per
// IP with no key, so every call is proxied server-side and cached (see
// /api/holders) — the browser never hits Blockscout directly.
//
// Used ONLY for holder/transfer data. Price and backing never come from here:
// Blockscout returns null exchange_rate on this chain, and backing is chain-only
// via BackingLens (CLAUDE.md).
export const BLOCKSCOUT_URL =
  process.env.NEXT_PUBLIC_BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";

export type Holder = {
  address: string;
  value: string; // raw token units (wei string) — kept as string to avoid bigint JSON loss
  isContract: boolean;
  // Blockscout's own label for known contracts (e.g. "PoolManager", "BallastSeeder"),
  // used to explain why one address holds most of the supply.
  name?: string;
};

export type HoldersData = {
  available: boolean;
  source: "Blockscout";
  reason?: "no-token" | "unreachable" | "not-found";
  fetchedAt?: number; // unix seconds — when our server fetched it
  holdersCount?: number;
  totalSupply?: string; // raw units
  decimals?: number;
  holders: Holder[]; // top holders by balance, descending (Blockscout order)
};

// Share of supply as a percentage number, from raw-unit strings. Uses BigInt then
// scales, so a 1e27 supply doesn't lose precision through float.
export function holderSharePct(value: string, totalSupply: string | undefined): number | undefined {
  if (!totalSupply) return undefined;
  try {
    const v = BigInt(value);
    const t = BigInt(totalSupply);
    if (t === 0n) return undefined;
    return Number((v * 1_000_000n) / t) / 10_000; // 4dp percent
  } catch {
    return undefined;
  }
}
