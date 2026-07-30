import Link from "next/link";
import { Container } from "@/components/Container";
import { Wordmark } from "@/components/Wordmark";
import { SocialIcon } from "@/components/SocialIcon";
import { COMMUNITY_LINKS } from "@/lib/links";

const COLS = [
  {
    heading: "Product",
    links: [
      { href: "/app/discover", label: "Discover" },
      { href: "/app/create", label: "Launch a project" },
      { href: "/app/portfolio", label: "Portfolio" },
    ],
  },
  {
    heading: "Learn",
    links: [
      { href: "/docs/how-ballast-works", label: "How ballast works" },
      { href: "/docs/what-ballast-is-not", label: "What ballast is not" },
      { href: "/docs/verify-a-treasury", label: "Verify a treasury yourself" },
      { href: "/docs/contract-addresses", label: "Contract addresses" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border">
      <Container className="py-12">
        <div className="grid gap-10 md:grid-cols-[1.5fr_repeat(3,1fr)]">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-xs text-sm text-text-muted">
              A launchpad on Robinhood Chain where a token can be measured against
              something real.
            </p>
          </div>
          {COLS.map((col) => (
            <div key={col.heading}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-faint">
                {col.heading}
              </h3>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-sm text-text-secondary hover:text-text-primary"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Community / social — X, both Telegram links (labelled distinctly), Docs,
            and GitHub once the repo is public. Anchor tags only, no web3. */}
        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-6">
          {COMMUNITY_LINKS.map((l) =>
            l.external ? (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
              >
                <SocialIcon name={l.icon} />
                {l.label}
              </a>
            ) : (
              <Link
                key={l.href}
                href={l.href}
                className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
              >
                <SocialIcon name={l.icon} />
                {l.label}
              </Link>
            ),
          )}
        </div>

        {/* Legal footer copy — verbatim from landing-copy doc §Footer. */}
        <div className="mt-12 border-t border-border pt-6 text-sm text-text-muted">
          <p>
            BALLAST reports on-chain data. It is not investment advice, and nothing
            here is a recommendation to buy or sell any asset. Token holders have no
            claim on any project treasury. Crypto assets are volatile and you can
            lose everything you put in.
          </p>
          <p className="mt-3 text-text-faint">
            Not affiliated with, endorsed by, or connected to Robinhood Markets, Inc.
          </p>
        </div>
      </Container>
    </footer>
  );
}
