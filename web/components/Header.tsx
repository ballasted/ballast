"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Container } from "@/components/Container";
import { Wordmark } from "@/components/Wordmark";
import { cn } from "@/lib/cn";

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#what-ballast-is", label: "What ballast is" },
];

export function Header() {
  // Past the hero the header gains its border + a denser background. Just a
  // 150ms color/opacity shift — no size change, no CLS. A passive scroll listener,
  // no web3.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 64);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 backdrop-blur transition-colors duration-150",
        scrolled ? "border-b border-border bg-bg/90" : "border-b border-transparent bg-bg/40",
      )}
    >
      <Container className="flex h-14 items-center justify-between">
        <Wordmark />
        <nav className="hidden items-center gap-6 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm text-text-secondary transition-colors duration-150 hover:text-text-primary"
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
            className="hidden rounded-button px-3 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:text-text-primary sm:inline-block"
          >
            Explore
          </Link>
          <Link
            href="/app/create"
            className="rounded-button bg-green px-3.5 py-1.5 text-sm font-semibold text-bg transition-opacity duration-150 hover:opacity-90"
          >
            Launch a project
          </Link>
        </div>
      </Container>
    </header>
  );
}
