import Link from "next/link";
import { Container } from "@/components/Container";
import { DOC_PAGES } from "./docs-nav";

// Docs ship on day one — for a product whose whole pitch is legibility, docs are
// part of the product (build-spec §8). The four required pages are linked here.

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Container className="py-12">
      <div className="grid gap-10 md:grid-cols-[220px_1fr]">
        <aside className="md:sticky md:top-20 md:self-start">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-faint">
            Documentation
          </p>
          <nav className="mt-3 flex flex-col gap-1">
            <Link
              href="/docs"
              className="rounded px-2 py-1.5 text-sm text-text-secondary hover:bg-card hover:text-text-primary"
            >
              Overview
            </Link>
            {DOC_PAGES.map((p) => (
              <Link
                key={p.href}
                href={p.href}
                className="rounded px-2 py-1.5 text-sm text-text-secondary hover:bg-card hover:text-text-primary"
              >
                {p.label}
              </Link>
            ))}
          </nav>
        </aside>
        <article className="prose-doc min-w-0 max-w-prose">{children}</article>
      </div>
    </Container>
  );
}
