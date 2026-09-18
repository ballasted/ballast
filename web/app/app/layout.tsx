"use client";

import { usePathname } from "next/navigation";
import { Providers } from "./providers";
import { Ambience } from "@/components/app/Ambience";
import { BottomNav } from "@/components/app/BottomNav";
import { EventToasts } from "@/components/app/EventToasts";
import { SideNav } from "@/components/app/SideNav";
import { TopBar } from "@/components/app/TopBar";
import { ConfigGuard } from "@/components/app/ConfigGuard";
import { NetworkGuard } from "@/components/app/NetworkGuard";
import { cn } from "@/lib/cn";

// APP LAYOUT — this is the ONLY segment wrapped in web3 providers. The marketing
// root layout stays free of wallet code (build-spec §8, CLAUDE.md).
//
// Responsive shell: primary navigation lives in TopBar's nav row at lg+ (every
// route except terminal). The fixed left SideNav survives ONLY on
// /app/terminal, where the density of a persistent rail earns its keep (chart
// + panels want the vertical space back); TopBar's own nav hides there in
// turn, so nav never shows twice. Below lg, neither renders — BottomNav's
// plain 4-item tab bar is the only nav there, regardless of route.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hasRail = pathname?.startsWith("/app/terminal") ?? false;

  return (
    <Providers>
      {/* Ambient depth behind everything — a fixed, faint light source so the app
          never reads as flat edge-to-edge black (spec §3, "Surface style"). */}
      <Ambience variant="page" />
      <EventToasts />
      {hasRail && <SideNav />}
      <div className={cn("flex min-h-dvh flex-col", hasRail && "lg:pl-60")}>
        <TopBar hasRail={hasRail} />
        <ConfigGuard />
        <NetworkGuard />
        {/* Content sits in a wide column, centred. Bottom padding below lg clears
            BottomNav's fixed tab bar plus the device safe-area inset; at lg+ the
            tab bar doesn't render, so padding drops back to normal. */}
        <main className="mx-auto w-full max-w-content flex-1 px-6 pb-[calc(52px+env(safe-area-inset-bottom))] pt-5 lg:px-10 lg:pb-10">
          {children}
        </main>
        <BottomNav />
      </div>
    </Providers>
  );
}
