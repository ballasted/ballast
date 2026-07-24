"use client";

import { createAppKit } from "@reown/appkit/react";
import { wagmiAdapter, robinhoodNetwork, projectId, appKitEnabled } from "./wagmi";

// Creates the AppKit modal once, styled to the BALLAST palette so it doesn't read
// as a third-party component dropped in (spec 1.1). Imported for its side effect by
// the /app provider. Only runs when a reown project id is configured; otherwise the
// connect button falls back to injected-wallet discovery.
//
// createAppKit is SSR-safe (it defers DOM work to the browser), so calling it at
// module scope is the supported Next.js App Router pattern.
if (appKitEnabled) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [robinhoodNetwork],
    defaultNetwork: robinhoodNetwork,
    projectId,
    metadata: {
      name: "BALLAST",
      description: "Launch with something underneath.",
      url: "https://ballasted.xyz",
      icons: ["https://ballasted.xyz/icon.png"],
    },
    // Disclosure product — no analytics, no email/social login funnels.
    features: { analytics: false, email: false, socials: [] },
    allWallets: "SHOW",
    themeMode: "dark",
    themeVariables: {
      "--w3m-accent": "#00C805",
      "--w3m-color-mix": "#0A0C0B",
      "--w3m-color-mix-strength": 40,
      "--w3m-border-radius-master": "2px",
      "--w3m-font-family":
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    },
  });
}
