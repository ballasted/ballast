"use client";

import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";
import { TermsGate } from "@/components/app/TermsGate";
// NB: @/lib/appkit is intentionally NOT imported here — it's loaded lazily by the
// connect button so the AppKit modal UI stays out of the initial /app bundle.

// Web3 providers. This component — and everything it wraps — is the ONLY place
// wagmi/viem/reown load. Imported by app/app/layout.tsx alone, so marketing
// visitors never download it.
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        <TermsGate />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
