import type { Metadata, Viewport } from "next";
import { SAME_AS, X_HANDLE } from "@/lib/links";
import "./globals.css";

// ROOT LAYOUT — html/body only. Deliberately contains NO web3 providers.
// Wallet providers must wrap ONLY the /app segment (app/app/layout.tsx), so a
// marketing visitor never downloads the web3 bundle before reading a word.
// This is a hard rule from CLAUDE.md and build-spec §8.

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://ballasted.xyz";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "BALLAST — Launch with something underneath",
    template: "%s · BALLAST",
  },
  description:
    "A launchpad on Robinhood Chain where projects can hold a treasury of tokenized real-world assets — and anyone can see exactly how much, per token, live.",
  openGraph: {
    title: "BALLAST — Launch with something underneath",
    description:
      "See a project's on-chain treasury priced live as backing per token. Disclosure, not a promise.",
    url: SITE_URL,
    siteName: "BALLAST",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
    title: "BALLAST — Launch with something underneath",
    description:
      "See a project's on-chain treasury priced live as backing per token.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0A0C0B",
  width: "device-width",
  initialScale: 1,
  // Let content extend under the notch/home-indicator so env(safe-area-inset-*)
  // resolves to real values — the app's bottom nav relies on it (Phase 1 bug 4).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Organization schema so search engines associate our X + Telegram profiles with
  // the project (sameAs). Static JSON — no web3, keeps the marketing bundle clean.
  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "BALLAST",
    url: SITE_URL,
    sameAs: SAME_AS,
  };
  return (
    <html lang="en">
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
