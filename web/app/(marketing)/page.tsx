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

// Disc + core sizing for the orbit. Radius is computed from the LIVE ticker
// count so discs never overlap each other (chord distance >= disc diameter)
// or the core mark at centre, regardless of whether the registry has 10
// tickers today or grows to 16+ later — a fixed pixel radius tuned for one
// count would start overlapping the moment the live list changes size.
const ORBIT_DISC_SIZE = 56;
const ORBIT_CORE_SIZE = 56; // matches the h-14 w-14 core-pulse circle

function orbitRadius(n: number): number {
  if (n <= 1) return ORBIT_CORE_SIZE / 2 + ORBIT_DISC_SIZE / 2 + 14;
  const noOverlap = ORBIT_DISC_SIZE / (2 * Math.sin(Math.PI / n)) + 8;
  const clearsCore = ORBIT_CORE_SIZE / 2 + ORBIT_DISC_SIZE / 2 + 14;
  return Math.max(noOverlap, clearsCore);
}

function Hero({ stats, orbitTickers }: { stats: HeroStats; orbitTickers: string[] }) {
  const week = stats.available ? String(stats.launchesThisWeek) : "—";
  const n = orbitTickers.length || 1;
  const radius = orbitRadius(n);
  const containerSize = Math.ceil(2 * (radius + ORBIT_DISC_SIZE / 2) + 16);
  return (
    <section className="relative overflow-hidden border-b border-border">
      <MeanderWatermark />
      <Container className="py-20 sm:py-32">
        <div className="flex flex-col items-center text-center">
          <div
            className="anim-enter hero-orbit relative mx-auto"
            style={{ width: containerSize, height: containerSize }}
            aria-hidden
          >
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="core-pulse flex items-center justify-center rounded-full bg-surface-raised"
                style={{ width: ORBIT_CORE_SIZE, height: ORBIT_CORE_SIZE }}
              >
                <KeelMark size={28} />
              </div>
            </div>
            <div className="hero-orbit-ring absolute inset-0">
              {orbitTickers.map((symbol, i) => {
                const angle = `${(360 / n) * i}deg`;
                const slotStyle = { "--a": angle, "--r": `0px, -${radius}px` } as CSSProperties;
                const faceStyle = { "--a": angle } as CSSProperties;
                return (
                  <div
                    key={symbol}
                    className="hero-orbit-slot absolute left-1/2 top-1/2 h-0 w-0"
                    style={slotStyle}
                  >
                    <div className="hero-orbit-face" style={faceStyle}>
                      <div className="hero-orbit-spin">
                        <OrbitDisc symbol={symbol} size={ORBIT_DISC_SIZE} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <h1 className="anim-enter anim-d1 mt-12 max-w-2xl font-serif text-4xl font-bold tracking-tight text-bone sm:text-6xl">
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
