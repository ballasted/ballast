import Link from "next/link";
import type { Address } from "viem";

// $BALLAST — the protocol's OWN token, launched by the BALLAST team on BALLAST
// under the same rules as every other launch. "Official protocol token" makes
// people assume rights it doesn't grant, so this notice states plainly what it
// confers (nothing) and leads with the true, strong fact: the team holds none of
// it. Above the fold, same blunt voice as "what BALLAST is not".
//
// The record is amended, not rewritten silently: this page previously said
// $BALLAST was NOT a protocol token; that changed on the date below. A disclosure
// product shouldn't quietly edit its own history — so when the launch factory was
// redeployed (corrected freshness gate), that too is recorded below as a dated
// line, and $BALLAST was deliberately NOT relaunched: it stays the original launch
// from the first factory, still listed via the multi-factory union.
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
      <h2 className="font-serif text-lg font-semibold text-bone">The protocol token</h2>
      <div className="mt-2 space-y-2 text-sm text-text-secondary">
        <p>
          Launched by the BALLAST team under the same rules as every launch: 100% of supply seeded the pool, no
          presale, no team allocation — we hold none of it. It confers no ownership, governance, claim, or
          redemption right.
        </p>
        <p>
          The protocol&apos;s swap-fee share funds open-market{" "}
          <Link href="/app/buyback" className="text-green underline underline-offset-2">
            buybacks of $BALLAST, then burned
          </Link>{" "}
          — value routed through the market, not distributed. Not a dividend; burning reduces supply and predicts
          nothing about price.
        </p>
        <p className="text-text-faint">
          Amendments: &ldquo;no revenue share&rdquo; wording corrected 4 Aug 2026 once buyback-and-burn started
          (holders still have no claim, redemption right, or governance); this page said $BALLAST was not a
          protocol token until 28 Jul 2026, before any trading occurred.
        </p>
        <p className="text-text-faint">
          The launch factory was redeployed 28 Jul 2026 (corrected freshness gate). $BALLAST was not relaunched —
          it&apos;s still the original listing; only new launches use the new factory.
        </p>
      </div>
    </section>
  );
}
