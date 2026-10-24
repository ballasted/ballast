"use client";

import { usePathname } from "next/navigation";
import { Providers } from "./providers";
import { Ambience } from "@/components/app/Ambience";
import { BottomNav } from "@/components/app/BottomNav";
import { EventToasts } from "@/components/app/EventToasts";
import { MoreMenuProvider } from "@/components/app/MoreMenu";
import { SideNav } from "@/components/app/SideNav";
import { TopBar } from "@/components/app/TopBar";
import { ConfigGuard } from "@/components/app/ConfigGuard";
import { NetworkGuard } from "@/components/app/NetworkGuard";
import { cn } from "@/lib/cn";

// APP LAYOUT — this is the ONLY segment wrapped in web3 providers. The marketing
// root layout stays free of wallet code (build-spec §8, CLAUDE.md).
//
// Responsive shell: at lg+, the slim left icon rail (SideNav, ~72px) is the
// primary navigation on EVERY route — there is no desktop top bar. Below lg,
// SideNav is hidden and the mobile TopBar (logo + wallet) sits above a
// BottomNav 4-item tab bar. The Mini App drops all chrome.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The Telegram launch Mini App runs inside the Telegram webview — render it
  // full-screen and chrome-free (no app nav / ticker), keeping only the wallet
  // Providers so the launch still signs in the user's own wallet.
  const isMiniApp = pathname?.startsWith("/app/tg-launch") ?? false;
  const hasRail = !isMiniApp;

  return (
    <Providers>
      {/* Ambient depth behind everything — a fixed, faint light source so the app
          never reads as flat edge-to-edge black (spec §3, "Surface style"). */}
      <Ambience variant="page" />
      <EventToasts />
      {/* One shared "More" sheet, opened by both the header hamburger (TopBar)
          and the bottom bar's More tab (BottomNav) — both live inside here. */}
      <MoreMenuProvider>
        {hasRail && <SideNav />}
        <div className={cn("flex min-h-dvh flex-col", hasRail && "lg:pl-[72px]")}>
          {!isMiniApp && <TopBar />}
          <ConfigGuard />
          <NetworkGuard />
          {/* Content sits in a wide column, centred. Bottom padding below lg clears
              BottomNav's fixed tab bar plus the device safe-area inset; at lg+ the
              tab bar doesn't render, so padding drops back to normal. The Mini App
              drops all of that for a tight full-screen webview layout. */}
          <main
            className={cn(
              "mx-auto w-full max-w-content flex-1",
              isMiniApp
                ? "px-4 py-4"
                : "px-6 pb-[calc(52px+env(safe-area-inset-bottom))] pt-5 lg:px-10 lg:pb-10",
            )}
          >
            {children}
          </main>
          {!isMiniApp && <BottomNav />}
        </div>
      </MoreMenuProvider>
    </Providers>
  );
}
