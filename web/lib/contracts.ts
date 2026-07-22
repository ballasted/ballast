import type { Address } from "viem";

// Contract addresses come from env, filled after deployment. Never hardcode
// per-launch addresses — those resolve from the factory registry / creation
// events (build-spec §12, CLAUDE.md conventions).

function asAddress(v: string | undefined): Address | undefined {
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  return v as Address;
}

export const LENS_ADDRESS = asAddress(process.env.NEXT_PUBLIC_LENS_ADDRESS);
export const ASSET_REGISTRY_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS,
);
export const FACTORY_ADDRESS = asAddress(process.env.NEXT_PUBLIC_FACTORY_ADDRESS);

// Temporary project source until the factory registry / indexer exists:
// a comma-separated list of ProjectTreasury addresses. Discover reads each one
// through BackingLens. Once the factory ships, this is replaced by a registry read.
export const DISCOVER_TREASURIES: Address[] = (
  process.env.NEXT_PUBLIC_DISCOVER_TREASURIES ?? ""
)
  .split(",")
  .map((s) => asAddress(s.trim()))
  .filter((a): a is Address => Boolean(a));

export const isLensConfigured = Boolean(LENS_ADDRESS);
