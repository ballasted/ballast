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
          Launched by the BALLAST team on BALLAST, under exactly the same rules as every other launch: 100% of supply
          seeded the pool, no presale, no team allocation. We hold none of it.
        </p>
        <p>
          It confers no ownership, no governance, and no claim, redemption right, or entitlement to the protocol or its
          fees.
        </p>
        <p>
          The protocol&apos;s share of swap fees funds open-market{" "}
          <Link href="/app/buyback" className="text-green underline underline-offset-2">
            buybacks of $BALLAST that are then burned
          </Link>
          . So protocol fees do flow back — through market buying and burning, not a distribution. This grants holders no
          claim and is not a dividend; burning reduces supply and predicts nothing about price.
        </p>
        <p className="text-text-faint">
          Previously this page stated $BALLAST confers &ldquo;no revenue share.&rdquo; Corrected on 4 August 2026: the
          protocol fee share now funds buyback-and-burn — value routed through the market, not distributed — so that
          wording was no longer accurate. Holders still have no claim, redemption right, or governance.
        </p>
        <p className="text-text-faint">
          Previously this page stated $BALLAST was not a protocol token. That changed on 28 July 2026 — before any
          trading occurred.
        </p>
        <p className="text-text-faint">
          On 28 July 2026 the launch factory was redeployed with a corrected freshness gate for backed launches.
          $BALLAST was not relaunched: it remains the original launch from the first factory and is still listed here.
          Only new launches use the new factory; nothing about $BALLAST changed on-chain.
        </p>
      </div>
    </section>
  );
}
