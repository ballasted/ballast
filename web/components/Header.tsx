import Link from "next/link";
import { Container } from "@/components/Container";
import { Wordmark } from "@/components/Wordmark";

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#what-ballast-is", label: "What ballast is" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
      <Container className="flex h-14 items-center justify-between">
        <Wordmark />
        <nav className="hidden items-center gap-6 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm text-text-secondary hover:text-text-primary"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          {/* Links into the /app segment. That segment (not this header) owns the
              web3 bundle, so these are plain links, not wallet buttons. */}
          <Link
            href="/app/discover"
            className="hidden rounded-button px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary sm:inline-block"
          >
            Explore
          </Link>
          <Link
            href="/app/create"
            className="rounded-button bg-green px-3.5 py-1.5 text-sm font-semibold text-bg hover:opacity-90"
          >
            Launch a project
          </Link>
        </div>
      </Container>
    </header>
  );
}
