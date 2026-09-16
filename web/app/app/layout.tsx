"use client";

import { usePathname } from "next/navigation";
import { Providers } from "./providers";
import { Ambience } from "@/components/app/Ambience";
import { BottomNav } from "@/components/app/BottomNav";
import { SideNav } from "@/components/app/SideNav";
import { TopBar } from "@/components/app/TopBar";
import { TickerBar } from "@/components/app/TickerBar";
import { ConfigGuard } from "@/components/app/ConfigGuard";
import { NetworkGuard } from "@/components/app/NetworkGuard";
import { cn } from "@/lib/cn";

// APP LAYOUT — this is the ONLY segment wrapped in web3 providers. The marketing
// root layout stays free of wallet code (build-spec §8, CLAUDE.md).
//
// Responsive shell: primary navigation lives in TopBar (horizontal, all routes).
// The fixed left SideNav survives ONLY on /app/terminal, where the density of a
// persistent rail earns its keep (chart + panels want the vertical space back);
// everywhere else content runs full width. TopBar's own horizontal nav hides on
// terminal in turn, so the rail's nav and the topbar's nav never both show at
// once. Below lg, SideNav never renders — BottomNav covers navigation there
// regardless of route.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hasRail = pathname?.startsWith("/app/terminal") ?? false;

  return (
    <Providers>
      {/* Ambient depth behind everything — a fixed, faint light source so the app
          never reads as flat edge-to-edge black (spec §3, "Surface style"). */}
      <Ambience variant="page" />
      {hasRail && <SideNav />}
      <div className={cn("flex min-h-screen flex-col", hasRail && "lg:pl-60")}>
        <TopBar hasRail={hasRail} />
        <ConfigGuard />
        <NetworkGuard />
        {/* Content sits in a wide column, centred. Bottom padding clears the fixed
            bottom nav PLUS the device safe-area inset on mobile; on desktop it
            clears the fixed TickerBar instead. */}
        <main className="mx-auto w-full max-w-content flex-1 px-6 pb-[calc(72px+env(safe-area-inset-bottom))] pt-5 lg:px-10 lg:pb-16">
          {children}
        </main>
        <BottomNav />
        <TickerBar hasRail={hasRail} />
      </div>
    </Providers>
  );
}
