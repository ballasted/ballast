import Link from "next/link";
import type { Address } from "viem";
import { isRetiredToken, RETIRED_NOTICES, BALLAST_V2_TOKEN_ADDRESS } from "@/lib/contracts";

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

// $BALLAST v2 — the current protocol token, the correct default so an unset env
// var pins v2, never the retired v1. (v1 migrated to v2; the claim window closed
// 2026-10-12.) NEXT_PUBLIC_PINNED_TOKEN_ADDRESS still overrides this if the
// pinned token is ever retired/replaced again — see docs/VERCEL-ENV-CHECKLIST.md.
const DEFAULT_PROTOCOL_TOKEN = "0xdc605041f02e41cbd8fdc347023e93c4c3fa243c" as const;

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
  // Retired token (e.g. $BALLAST v1) — always show the migrated banner + link to
  // v2, regardless of env/pinning. Takes precedence over the pinned-token logic.
  if (isRetiredToken(token)) {
    const migratedTo = (token && RETIRED_NOTICES[token.toLowerCase()]?.migratedTo) ?? BALLAST_V2_TOKEN_ADDRESS;
    return (
      <section className="card border-accent p-5" role="note">
        <div className="flex items-center justify-between gap-3">
          <span className="chip chip-neutral">v1 · migrated to v2</span>
          <Link href={`/app/token/${migratedTo}`} className="text-xs text-green underline underline-offset-2">
            $BALLAST v2 ↗
          </Link>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          This is $BALLAST v1. It has been migrated to $BALLAST v2. The migration claim window closed on Oct 12, 2026.
        </p>
      </section>
    );
  }

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
        <Link href="/app/migrate" className="mt-2 inline-block text-xs text-green underline underline-offset-2">
          Burn v1, claim ETH ↗
        </Link>
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
