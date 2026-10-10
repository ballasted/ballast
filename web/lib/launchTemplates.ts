// Pure logic for the Create flow's theme presets (Section B). Kept separate
// from the component (LaunchTemplates.tsx) so it has zero JSX / "@/lib/cn"
// dependency and is trivially unit-testable — mirrors pairingAssets.ts in
// this directory (pure, chain-independent data next to the live hook that
// supplies real candidates).
//
// A preset is a pure shortcut into existing form state: it prefills the
// quote-asset picks and a suggested (still-editable) description. It never
// fires a contract call, and it is only ever resolved against candidates
// already proven live-green by useQuoteAssets (which itself reads the
// CURRENT factory's isGreenQuoteAsset() on-chain) — never a hardcoded
// address or ticker list.
import type { Address } from "viem";

// Structural subset of useQuoteAssets' QuoteAssetCandidate — duplicated here
// (not imported) so this module never depends on "@/hooks/*" path aliases.
export type QuoteAssetCandidateLike = {
  address: Address;
  symbol?: string;
  isWeth: boolean;
  isGreen: boolean;
};

export type Preset = {
  key: string;
  label: string;
  symbols: string[]; // "WETH" matches the WETH candidate; others match by symbol (case-insensitive)
  description: string;
};

export const PRESETS: Preset[] = [
  { key: "ai", label: "AI", symbols: ["WETH", "NVDA"], description: "Paired against WETH and NVDA." },
  { key: "cash", label: "Cash-like", symbols: ["WETH", "SGOV"], description: "Paired against WETH and SGOV." },
  { key: "index", label: "Index", symbols: ["WETH", "SPY"], description: "Paired against WETH and SPY." },
  { key: "eth", label: "ETH only", symbols: ["WETH"], description: "Paired against WETH only." },
];

/** Resolve a preset's symbols to live addresses. Returns null (drop the
 *  preset entirely) unless EVERY symbol matches a candidate confirmed green
 *  TODAY, and the pick fits under the live quote-asset cap. Never a partial
 *  match, never a guess on an unresolved/failed read (QuoteAssetCandidate's
 *  own isGreen already folds "unresolved" into false upstream). */
export function resolvePreset(
  preset: Preset,
  candidates: QuoteAssetCandidateLike[],
  maxQuotes: number,
): Address[] | null {
  if (preset.symbols.length > maxQuotes) return null;
  const addresses: Address[] = [];
  for (const sym of preset.symbols) {
    const match = candidates.find((c) =>
      sym === "WETH" ? c.isWeth : !c.isWeth && (c.symbol ?? "").toUpperCase() === sym,
    );
    if (!match || !match.isGreen) return null;
    addresses.push(match.address);
  }
  return addresses;
}

/** Every preset whose assets are live-accepted today, paired with its
 *  resolved addresses. Order follows PRESETS. */
export function availablePresets(
  candidates: QuoteAssetCandidateLike[],
  maxQuotes: number,
): Array<{ preset: Preset; addresses: Address[] }> {
  const out: Array<{ preset: Preset; addresses: Address[] }> = [];
  for (const preset of PRESETS) {
    const addresses = resolvePreset(preset, candidates, maxQuotes);
    if (addresses) out.push({ preset, addresses });
  }
  return out;
}
