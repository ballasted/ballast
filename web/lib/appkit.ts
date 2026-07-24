"use client";

import { createAppKit } from "@reown/appkit/react";
import { wagmiAdapter, robinhoodNetwork, projectId, appKitEnabled } from "./wagmi";

// Loaded ONLY via dynamic import from the connect button (see ConnectButton), so
// the heavy AppKit modal UI stays out of the initial /app bundle and loads the
// moment someone actually opens the picker — not on every page view.
//
// It wires the SAME wagmiAdapter instance the app is already wrapped in, so a
// connection made in the modal flows straight into wagmi's useAccount, and a
// returning user reconnects (via the eager adapter) without this module loading
// at all. We export the imperative `modal` handle rather than using the
// useAppKit() hook, precisely so nothing here is referenced statically.
export const modal = appKitEnabled
  ? createAppKit({
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
    })
  : null;
