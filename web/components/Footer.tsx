import Link from "next/link";
import { Container } from "@/components/Container";
import { Wordmark } from "@/components/Wordmark";
import { SocialIcon } from "@/components/SocialIcon";
import { COMMUNITY_LINKS } from "@/lib/links";

// Footer is one row: mark on the left, exactly X / Telegram / Docs on the
// right. No Product/Learn/Legal columns — those links live in the app nav
// and /docs itself. /terms and /privacy stay live as routes, just unlinked
// here.
export function Footer() {
  return (
    <footer className="border-t border-border">
      <Container className="flex flex-wrap items-center justify-between gap-4 py-8">
        <Wordmark />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
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
      </Container>
    </footer>
  );
}
