import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { SAME_AS, X_HANDLE } from "@/lib/links";
import "./globals.css";

// Self-hosted at build time by next/font (no runtime request to Google Fonts,
// so this doesn't reopen the "marketing bundle stays offline-safe" concern the
// previous system-font stack was chosen for — see tailwind.config.ts).
//
// Single UI typeface sitewide (Space Grotesk, weights 400-700) — the display
// serif register (Playfair Display) is retired; `--font-display` now points
// at the same family so any lingering `font-serif` usage still resolves
// instead of silently falling back to a system serif.
const sans = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans", display: "swap" });
// Same family, second next/font instance so `--font-display` (the token
// `font-serif` still resolves to in tailwind.config.ts) points at Space
// Grotesk too rather than silently falling back to a system serif.
const display = Space_Grotesk({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-display", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

// ROOT LAYOUT — html/body only. Deliberately contains NO web3 providers.
// Wallet providers must wrap ONLY the /app segment (app/app/layout.tsx), so a
// marketing visitor never downloads the web3 bundle before reading a word.
// This is a hard rule from CLAUDE.md and build-spec §8.

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://ballasted.fun";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "BALLAST — Launch with something underneath",
    template: "%s · BALLAST",
  },
  description:
    "A launchpad on Robinhood Chain where projects can hold a treasury of tokenized real-world assets — and anyone can see exactly how much, per token, live.",
  openGraph: {
    title: "Ballast — Launch against real stocks",
    description:
      "Token launchpad on Robinhood Chain. Stock pairs, stock treasury, opens at 1 ETH.",
    url: SITE_URL,
    siteName: "Ballast",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
    title: "Ballast — Launch against real stocks",
    description:
      "Token launchpad on Robinhood Chain. Stock pairs, stock treasury, opens at 1 ETH.",
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#050A06",
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
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
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
