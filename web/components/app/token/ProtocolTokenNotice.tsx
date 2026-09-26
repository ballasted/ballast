import Link from "next/link";
import type { Address } from "viem";

function asAddress(v: string | undefined): Address | undefined {
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  return v.toLowerCase() as Address;
}

function parseAddressList(v: string | undefined): Address[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => asAddress(s.trim()))
    .filter((a): a is Address => Boolean(a));
}

// $BALLAST v1 — the original protocol token. Kept as the default so an unset
// env var doesn't un-pin anything. Once v2 launches, set
// NEXT_PUBLIC_PINNED_TOKEN_ADDRESS to the new token and add this address to
// NEXT_PUBLIC_PRIOR_PINNED_TOKEN_ADDRESSES — see docs/VERCEL-ENV-CHECKLIST.md.
const DEFAULT_PROTOCOL_TOKEN = "0x069a260370c61d91bd3e9842d81d378f9750f7f3" as const;

/// @notice The CURRENT pinned protocol token (Discover's pin + this page's
///         "Protocol token" notice). Env-driven with the v1 address as
///         default, so relaunching is a config value, not a code change —
///         drives the Discover pin from the same source of truth (see
///         isProtocolToken below), matching the factory/hook union pattern in
///         lib/contracts.ts. Lowercased for a case-insensitive compare.
export const PROTOCOL_TOKEN_ADDRESS: Address =
  asAddress(process.env.NEXT_PUBLIC_PINNED_TOKEN_ADDRESS) ?? DEFAULT_PROTOCOL_TOKEN;

/// @notice Tokens that USED to be the pinned protocol token (newest-superseded
///         first). A token here is no longer pinned, but its page still shows
///         a "relaunched" notice instead of vanishing, and Discover/search
///         label it "v1 · migrated" instead of the standard state pill.
export const PRIOR_PINNED_TOKENS: Address[] = parseAddressList(
  process.env.NEXT_PUBLIC_PRIOR_PINNED_TOKEN_ADDRESSES,
);

export function isProtocolToken(token: Address | undefined): boolean {
  return Boolean(token) && token!.toLowerCase() === PROTOCOL_TOKEN_ADDRESS;
}

export function isPriorPinnedToken(token: Address | undefined): boolean {
  return Boolean(token) && PRIOR_PINNED_TOKENS.includes(token!.toLowerCase() as Address);
}

export function ProtocolTokenNotice({ token }: { token: Address | undefined }) {
  if (isPriorPinnedToken(token)) {
    return (
      <section className="card border-accent p-5" role="note">
        <div className="flex items-center justify-between gap-3">
          <span className="chip chip-neutral">v1 · migrated</span>
          <Link
            href={`/app/token/${PROTOCOL_TOKEN_ADDRESS}`}
            className="text-xs text-green underline underline-offset-2"
          >
            $BALLAST v2 ↗
          </Link>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          This is $BALLAST v1. It has been relaunched. This pool stays open and tradable — nothing here stops
          working.
        </p>
      </section>
    );
  }

  if (!isProtocolToken(token)) return null;
  return (
    <section className="card border-accent p-5" role="note">
      <div className="flex items-center justify-between gap-3">
        <span className="chip chip-accent">Protocol token</span>
        <Link href="/docs/corrections" className="text-xs text-text-faint underline underline-offset-2 hover:text-text-secondary">
          Amendment history ↗
        </Link>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
        <Row label="Team allocation" value="None" />
        <Row label="Governance" value="None" />
        <Row label="Redemption right" value="None" />
      </div>
      <Link href="/app/buyback" className="mt-3 inline-block text-xs text-green underline underline-offset-2">
        Fee share → buyback &amp; burn ↗
      </Link>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-text-faint">{label}</div>
      <div className="mt-0.5 font-medium text-text-primary">{value}</div>
    </div>
  );
}
