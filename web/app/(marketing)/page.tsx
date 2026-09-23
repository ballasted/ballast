import type { CSSProperties } from "react";
import Link from "next/link";
import { Container } from "@/components/Container";
import { Reveal } from "@/components/Reveal";
import { MeanderWatermark } from "@/components/MeanderWatermark";
import { OrbitDisc } from "@/components/OrbitDisc";
import { KeelMark } from "@/components/Wordmark";
import { getHeroStats, type HeroStats } from "@/lib/heroStats";
import { getOrbitTickers } from "@/lib/orbitTickers";
import { formatCompactUsd } from "@/lib/market";

// Landing page — UI principles: one headline, one line beneath it, motion, one
// button, one secondary link. Full explanation (what ballast is/is not, how it
// works, FAQ) lives at /docs, not here.

// The hero stats are read from chain SERVER-SIDE (see lib/heroStats). Revalidate
// ~60s so we don't hammer RPC on every view; the browser gets plain numbers, never
// a provider — the marketing tree stays free of the web3 bundle.
export const revalidate = 60;

export default async function LandingPage() {
  const [stats, orbitTickers] = await Promise.all([getHeroStats(), getOrbitTickers()]);
  return (
    <>
      <Hero stats={stats} orbitTickers={orbitTickers} />
      <FigureScreen
        value={stats.available ? formatCompactUsd(stats.totalBallastUsd ?? 0) : "—"}
        label="Total ballast, on-chain"
      />
      <FigureScreen
        value={stats.available ? String(stats.ballastedProjects) : "—"}
        label="Projects ballasted"
        muted
      />
    </>
  );
}

function Hero({ stats, orbitTickers }: { stats: HeroStats; orbitTickers: string[] }) {
  const week = stats.available ? String(stats.launchesThisWeek) : "—";
  return (
    <section className="relative overflow-hidden border-b border-border">
      <MeanderWatermark />
      <Container className="py-20 sm:py-32">
        <div className="flex flex-col items-center text-center">
          <div className="anim-enter hero-orbit relative mx-auto h-40 w-40" aria-hidden>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="core-pulse flex h-14 w-14 items-center justify-center rounded-full bg-surface-raised">
                <KeelMark size={28} />
              </div>
            </div>
            <div className="ring absolute inset-0">
              {orbitTickers.map((symbol, i) => {
                const angle = `${(360 / orbitTickers.length) * i}deg`;
                const angleVar = { "--a": angle } as CSSProperties;
                return (
                  <div key={symbol} className="slot absolute inset-0" style={angleVar}>
                    <div className="absolute left-1/2 top-0 -translate-x-1/2">
                      <div className="face" style={angleVar}>
                        <div className="spin">
                          <OrbitDisc symbol={symbol} size={32} />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <h1 className="anim-enter anim-d1 mt-8 max-w-2xl font-serif text-4xl font-bold tracking-tight text-bone sm:text-6xl">
            See exactly how much backs each token, live.
          </h1>

          <div className="anim-enter anim-d2 mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/app/create"
              className="rounded-button bg-green px-6 py-3 font-semibold text-bg transition-opacity hover:opacity-90"
            >
              Launch
            </Link>
            <Link
              href="/docs"
              className="rounded-button border border-border px-6 py-3 font-semibold text-text-primary transition-colors hover:border-text-muted"
            >
              Docs
            </Link>
          </div>

          <div className="anim-enter anim-d3 mt-10 font-mono text-sm text-text-faint">
            {week} launched this week
          </div>
        </div>
      </Container>
    </section>
  );
}

// One figure, one label — nothing else. Used for both scroll-reveal screens.
function FigureScreen({ value, label, muted }: { value: string; label: string; muted?: boolean }) {
  return (
    <section className={muted ? "border-b border-border bg-card/30" : "border-b border-border"}>
      <Container className="flex flex-col items-center justify-center py-24 text-center sm:py-32">
        <Reveal>
          <div key={value} className="anim-fade figure-primary text-6xl tabular-nums sm:text-7xl">
            {value}
          </div>
          <div className="mt-3 eyebrow">{label}</div>
        </Reveal>
      </Container>
    </section>
  );
}
