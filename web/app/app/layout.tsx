import { Providers } from "./providers";
import { BottomNav } from "@/components/app/BottomNav";
import { SideNav } from "@/components/app/SideNav";
import { ConnectButton } from "@/components/app/ConnectButton";
import { WalletBalance } from "@/components/app/WalletBalance";
import { ConfigGuard } from "@/components/app/ConfigGuard";
import { NetworkGuard } from "@/components/app/NetworkGuard";
import { Wordmark } from "@/components/Wordmark";

// APP LAYOUT — this is the ONLY segment wrapped in web3 providers. The marketing
// root layout stays free of wallet code (build-spec §8, CLAUDE.md).
//
// Responsive shell: a fixed left SideNav on desktop (lg+); on mobile that rail is
// hidden and a top header + bottom nav take over. The content column is shifted
// right of the sidebar on desktop (lg:pl-60) and clears the bottom bar on mobile.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      {/* Ambient depth behind everything — a fixed, faint light source so the app
          never reads as flat edge-to-edge black (density §1). */}
      <div className="ambient-bg" aria-hidden />
      <SideNav />
      <div className="flex min-h-screen flex-col lg:pl-60">
        {/* Mobile top bar — brand + wallet. Hidden on desktop, where the SideNav
            carries both. */}
        <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur lg:hidden">
          <div className="mx-auto flex h-14 max-w-content items-center justify-between px-6">
            <Wordmark />
            <div className="flex items-center gap-3">
              <WalletBalance className="hidden sm:inline" />
              <ConnectButton />
            </div>
          </div>
        </header>
        <ConfigGuard />
        <NetworkGuard />
        {/* Content sits in a 1200px column, centred in the space beside the sidebar.
            Bottom padding clears the fixed bottom nav PLUS the device safe-area inset
            on mobile; on desktop the bottom nav is gone, so it relaxes to a normal
            gutter. */}
        <main className="mx-auto w-full max-w-content flex-1 px-6 pb-[calc(72px+env(safe-area-inset-bottom))] pt-5 lg:px-10 lg:pb-12">
          {children}
        </main>
        <BottomNav />
      </div>
    </Providers>
  );
}
