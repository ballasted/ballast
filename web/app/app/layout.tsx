import Link from "next/link";
import { Providers } from "./providers";
import { BottomNav } from "@/components/app/BottomNav";
import { ConnectButton } from "@/components/app/ConnectButton";
import { WalletBalance } from "@/components/app/WalletBalance";
import { ConfigGuard } from "@/components/app/ConfigGuard";
import { NetworkGuard } from "@/components/app/NetworkGuard";
import { Wordmark } from "@/components/Wordmark";

// APP LAYOUT — this is the ONLY segment wrapped in web3 providers. The marketing
// root layout stays free of wallet code (build-spec §8, CLAUDE.md).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      {/* Ambient depth behind everything — a fixed, faint light source so the app
          never reads as flat edge-to-edge black (density §1). */}
      <div className="ambient-bg" aria-hidden />
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-content items-center justify-between px-6 lg:px-12">
            <Wordmark />
            <div className="flex items-center gap-3">
              <WalletBalance className="hidden sm:inline" />
              <ConnectButton />
            </div>
          </div>
        </header>
        <ConfigGuard />
        <NetworkGuard />
        {/* Content sits in a 1200px column with 24px (mobile) / 48px (desktop)
            gutters so it's anchored, not sprawling (density §1). Bottom padding
            clears the fixed bottom nav PLUS the device safe-area inset, so content
            is never obscured on mobile. Keep in sync with BottomNav's height. */}
        <main className="mx-auto w-full max-w-content flex-1 px-6 pb-[calc(72px+env(safe-area-inset-bottom))] pt-5 lg:px-12">
          {children}
        </main>
        <BottomNav />
      </div>
    </Providers>
  );
}
