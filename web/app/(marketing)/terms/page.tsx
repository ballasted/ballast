import type { Metadata } from "next";
import { Container } from "@/components/Container";

export const metadata: Metadata = {
  title: "Terms",
  description: "Terms of use for BALLAST.",
};

// NOTE FOR THE HUMAN: this is a plain-language scaffold, NOT reviewed legal copy.
// Build-spec §13 lists legal review — especially of the deposit flow wording — as
// a required human decision. Have counsel review before mainnet.
export default function TermsPage() {
  return (
    <Container prose className="py-16">
      <article className="prose-doc">
        <h1>Terms of Use</h1>
        <p className="text-text-muted">
          Draft scaffold — pending legal review. Last updated on deployment.
        </p>

        <h2>1. What BALLAST is</h2>
        <p>
          BALLAST is an interface to public smart contracts on Robinhood Chain. It
          displays on-chain data — including a treasury&apos;s contents and their
          value as backing per token. BALLAST does not custody your assets, execute
          trades on your behalf, or control any project&apos;s treasury.
        </p>

        <h2>2. No claim, no advice</h2>
        <p>
          Holding any project token gives you no claim, redemption right, or
          entitlement to any treasury asset. Nothing on BALLAST is investment,
          financial, legal, or tax advice, or a recommendation to buy or sell any
          asset. Figures shown are arithmetic on public data and may be delayed,
          incomplete, or, in the event of an oracle or indexing fault, wrong.
        </p>

        <h2>3. Risk</h2>
        <p>
          Crypto assets are volatile. Projects fail, treasuries shrink, and a token
          can and will trade below its backing. You can lose everything you put in.
          You are solely responsible for your own decisions and for complying with
          the laws that apply to you. Tokenized equities may be unavailable in your
          region.
        </p>

        <h2>4. Deposits are permanent for third parties</h2>
        <p>
          If you deposit assets to a treasury you do not own as its creator, that
          deposit is permanent once accepted. You cannot withdraw it, you receive
          nothing in return, and no one — including the creator — can withdraw it on
          your behalf.
        </p>

        <h2>5. Verification is control, not endorsement</h2>
        <p>
          Linked X accounts and websites prove that a project controls those
          accounts at a point in time. They are not an endorsement, and BALLAST does
          not vouch for any project.
        </p>

        <h2>6. Not affiliated with Robinhood</h2>
        <p>
          BALLAST is an independent project built on Robinhood Chain. It is not
          affiliated with, endorsed by, or connected to Robinhood Markets, Inc.
        </p>

        <h2>7. Changes</h2>
        <p>
          These terms may change. Continued use after a change constitutes
          acceptance of the updated terms.
        </p>
      </article>
    </Container>
  );
}
