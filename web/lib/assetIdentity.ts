import type { Address } from "viem";

/**
 * Asset identity is ADDRESS-first, always. A ticker/symbol string is decoration
 * that a resolver may show once an address has cleared the check below — it is
 * never itself the check. This exists because a real, live impostor does exactly
 * what you'd expect: a "GOOGL/WETH" Uniswap pool on Robinhood Chain reports a
 * fabricated multi-billion-dollar reserve at a DIFFERENT contract address than
 * the real Robinhood GOOGL token (see docs/exit-liquidity-table.md). Anything
 * that resolves "the GOOGL logo" by matching the string "GOOGL" — instead of by
 * checking the specific address against the canonical on-chain registry — would
 * render that impostor with the real Google logo and a real-looking number.
 *
 * The canonical registry is on-chain (AssetRegistry.sol) — it's what actually
 * gates value movement (ProjectTreasury.deposit, BallastFactory.launch's
 * isGreenQuoteAsset). This module doesn't duplicate that trust boundary; it
 * reads the SAME live data (via useAssets(), which reads AssetRegistry directly)
 * and applies the identical address-first check to what the UI is allowed to
 * DISPLAY as a recognized asset. A client-side check can't protect anyone not
 * using this frontend, and doesn't need to — the on-chain checks already stop
 * money from moving to/through an unlisted address regardless of any UI. This
 * one stops a user from being shown a trustworthy-looking mark for something
 * that was never actually registered.
 */
export type AssetIdentity =
  | { status: "loading" }
  | { status: "recognized"; symbol: string }
  | { status: "unrecognized" }
  /** The address is NOT in the registry, but something claims a symbol that
   *  matches a REAL registered asset's ticker. Not a coincidence worth a
   *  shrug — this is the exact shape of the fake-GOOGL pool. */
  | { status: "hostile"; claimedSymbol: string };

export type RegistryAssetRef = { address: Address; symbol?: string };

/**
 * @param address        the candidate asset's contract address (the only thing
 *                        that's ever actually checked)
 * @param claimedSymbol   whatever symbol string is floating around this call
 *                        site (e.g. an ERC-20's own symbol() — self-reported,
 *                        never trusted on its own)
 * @param registry        the live AssetRegistry-sourced list (from useAssets())
 * @param registryLoaded  false while the registry read is still in flight, so
 *                        callers can render a neutral/loading state instead of
 *                        a scary "unrecognized" flash before real data arrives
 */
export function resolveAssetIdentity(
  address: Address | undefined,
  claimedSymbol: string | undefined,
  registry: RegistryAssetRef[],
  registryLoaded: boolean,
): AssetIdentity {
  if (!registryLoaded) return { status: "loading" };
  if (!address) return { status: "unrecognized" };

  const match = registry.find((a) => a.address.toLowerCase() === address.toLowerCase());
  if (match) {
    // Even when recognized, prefer the registry's OWN live symbol read over
    // whatever the caller claimed — the address is what was verified, not the
    // string that happened to travel alongside it.
    return { status: "recognized", symbol: match.symbol ?? claimedSymbol ?? "" };
  }

  const collidesWithReal = Boolean(
    claimedSymbol && registry.some((a) => a.symbol?.toUpperCase() === claimedSymbol.toUpperCase()),
  );
  if (collidesWithReal) return { status: "hostile", claimedSymbol: claimedSymbol! };

  return { status: "unrecognized" };
}
