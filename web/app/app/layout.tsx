import Link from "next/link";
import { Providers } from "./providers";
import { BottomNav } from "@/components/app/BottomNav";
import { ConnectButton } from "@/components/app/ConnectButton";
import { ConfigGuard } from "@/components/app/ConfigGuard";
import { NetworkGuard } from "@/components/app/NetworkGuard";
import { Wordmark } from "@/components/Wordmark";

// APP LAYOUT — this is the ONLY segment wrapped in web3 providers. The marketing
// root layout stays free of wallet code (build-spec §8, CLAUDE.md).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-content items-center justify-between px-5">
            <Wordmark />
            <ConnectButton />
          </div>
        </header>
        <ConfigGuard />
        <NetworkGuard />
        {/* pb accounts for the fixed bottom nav */}
        <main className="mx-auto w-full max-w-content flex-1 px-5 pb-24 pt-4">
          {children}
        </main>
        <BottomNav />
      </div>
    </Providers>
  );
}
