import type { Address } from "viem";

export const BASKET_BPS = 10_000;

/** Even split across `addrs` in whole 1% (100bps) steps, remainder on the
 *  LAST entry (so, e.g., 3 assets -> 3333/3333/3334) — matches
 *  BallastFactory.graduate()'s own remainder-on-first-share convention in
 *  spirit (nothing is ever dust-lost to integer division). */
export function evenSplit(addrs: Address[]): Record<string, number> {
  if (addrs.length === 0) return {};
  const base = Math.floor(BASKET_BPS / addrs.length / 100) * 100;
  const out: Record<string, number> = {};
  let used = 0;
  addrs.forEach((a, i) => {
    const v = i === addrs.length - 1 ? BASKET_BPS - used : base;
    out[a] = v;
    used += v;
  });
  return out;
}

/** Sets `addr`'s weight to the nearest whole 1% of `pct` (0-100, clamped),
 *  redistributing the remainder evenly across every OTHER currently-selected
 *  address (remainder-on-last, same convention as evenSplit) so the full set
 *  always sums to exactly BASKET_BPS. If `addr` is the only selection, it
 *  simply takes the full 10000bps regardless of `pct`. */
export function snapWeight(selected: Address[], addr: Address, pct: number): Record<string, number> {
  const snapped = Math.round(Math.max(0, Math.min(100, pct))) * 100;
  const others = selected.filter((a) => a !== addr);
  if (others.length === 0) return { [addr]: BASKET_BPS };

  const remaining = BASKET_BPS - snapped;
  const evenOther = Math.floor(remaining / others.length / 100) * 100;
  const next: Record<string, number> = { [addr]: snapped };
  let usedByOthers = 0;
  others.forEach((a, i) => {
    const v = i === others.length - 1 ? remaining - evenOther * (others.length - 1) : evenOther;
    next[a] = Math.max(0, v);
    usedByOthers += next[a]!;
  });
  void usedByOthers;
  return next;
}

export function sumWeights(weights: Record<string, number>): number {
  return Object.values(weights).reduce((a, b) => a + b, 0);
}
