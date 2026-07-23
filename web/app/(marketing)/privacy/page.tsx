import type { Metadata } from "next";
import { Container } from "@/components/Container";

export const metadata: Metadata = {
  title: "Privacy",
  description: "Privacy policy for BALLAST.",
};

// NOTE FOR THE HUMAN: plain-language scaffold, pending legal review (build-spec §13).
export default function PrivacyPage() {
  return (
    <Container prose className="py-16">
      <article className="prose-doc">
        <h1>Privacy Policy</h1>
        <p className="text-text-muted">
          Draft scaffold — pending legal review. Last updated on deployment.
        </p>

        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>On-chain data.</strong> Public blockchain data (addresses,
            transactions, treasury balances) is inherently public. BALLAST reads and
            displays it; it does not make it public.
          </li>
          <li>
            <strong>X account link.</strong> When you link an X account we store its
            permanent numeric user ID (not just the handle) to attribute launches and
            surface link drift. We request only <code>users.read</code> and{" "}
            <code>tweet.read</code> scopes and never request write access.
          </li>
          <li>
            <strong>Website verification.</strong> We store the domain you claim and
            the outcome of the control check.
          </li>
          <li>
            <strong>Disclosure acknowledgements.</strong> When you confirm a
            disclosure (for example, before a permanent deposit) we record which
            version of the text you confirmed.
          </li>
        </ul>

        <h2>What we do not do</h2>
        <p>
          We do not sell your data. We do not custody your funds or your keys. We do
          not request write access to your X account.
        </p>

        <h2>Wallets</h2>
        <p>
          Connecting a wallet exposes its public address to the app. The marketing
          pages you are reading now load no wallet code at all.
        </p>

        <h2>Contact</h2>
        <p>Reach us through the channels linked in the footer.</p>
      </article>
    </Container>
  );
}
