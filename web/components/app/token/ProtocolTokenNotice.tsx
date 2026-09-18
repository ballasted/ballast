import Link from "next/link";
import type { Address } from "viem";

// $BALLAST — the protocol's OWN token, launched by the BALLAST team on BALLAST
// under the same rules as every other launch. Full amendment history (wording
// corrections, the factory redeploy) lives in /docs/corrections — a dated
// record we don't rewrite — rather than as paragraphs on this page.
//
// ⚠️ HARDCODED per-launch address — a deliberate, user-approved exception to the
// "never hardcode per-launch addresses" convention. When launch metadata carries a
// protocol-token flag, drive this (and the Discover pin) from that instead and
// delete the constant. Lowercased for a case-insensitive compare. Exported so the
// Discover pin resolves the same token from one source of truth.
export const PROTOCOL_TOKEN_ADDRESS = "0x069a260370c61d91bd3e9842d81d378f9750f7f3" as const;

export function isProtocolToken(token: Address | undefined): boolean {
  return Boolean(token) && token!.toLowerCase() === PROTOCOL_TOKEN_ADDRESS;
}

export function ProtocolTokenNotice({ token }: { token: Address | undefined }) {
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
