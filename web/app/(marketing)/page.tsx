import Link from "next/link";
import { Container } from "@/components/Container";
import { Reveal } from "@/components/Reveal";
import { FaqList } from "@/components/marketing/FaqList";
import { MeanderWatermark } from "@/components/MeanderWatermark";
import { getHeroStats, type HeroStats } from "@/lib/heroStats";
import { formatCompactUsd } from "@/lib/market";

// Landing page. Copy is lifted from docs/BALLAST-landing-copy.md and respects the
// hard copy rules: no "floor / guaranteed / protected / secured / safe / yield /
// returns / insured" in relation to ballast. Negative sections are NOT softened.

// The hero stats are read from chain SERVER-SIDE (see lib/heroStats). Revalidate
// ~60s so we don't hammer RPC on every view; the browser gets plain numbers, never
// a provider — the marketing tree stays free of the web3 bundle.
export const revalidate = 60;

export default async function LandingPage() {
  const stats = await getHeroStats();
  return (
    <>
      <Hero stats={stats} />
      <Problem />
      <Difference />
      <HowItWorks />
      <WhatBallastIs />
      <NotEveryProject />
      <Audiences />
      <Faq />
      <FinalCta />
    </>
  );
}

function Hero({ stats }: { stats: HeroStats }) {
  const ballasted = stats.available ? String(stats.ballastedProjects) : "—";
  const total = stats.available ? formatCompactUsd(stats.totalBallastUsd ?? 0) : "—";
  const week = stats.available ? String(stats.launchesThisWeek) : "—";
  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* Brand watermark bleeding off the corner — desktop only, ~2.5% opacity. */}
      <MeanderWatermark />
      <Container className="py-20 sm:py-28">
        {/* Hero entrance — staggered, once on load. transform + opacity only. */}
        <h1 className="anim-enter max-w-3xl font-serif text-4xl font-semibold tracking-tight text-bone sm:text-6xl">
          Launch with something underneath.
        </h1>
        <p className="anim-enter anim-d1 mt-6 max-w-2xl text-lg text-text-secondary">
          BALLAST is a launchpad on Robinhood Chain where projects can hold a
          treasury of tokenized real-world assets — and anyone can see exactly how
          much, per token, live.
        </p>
        <div className="anim-enter anim-d2 mt-8 flex flex-wrap gap-3">
          <Link
            href="/app/discover"
            className="rounded-button bg-green px-5 py-3 font-semibold text-bg transition-opacity hover:opacity-90"
          >
            Explore ballasted projects
          </Link>
          <Link
            href="/app/create"
            className="rounded-button border border-border px-5 py-3 font-semibold text-text-primary transition-colors hover:border-text-muted"
          >
            Launch a project
          </Link>
        </div>

        {/* Hero stat strip — LIVE, read server-side from the chain (same source as
            Discover, so they reconcile). Small real numbers, never a guess; on a
            read failure the dashes stay with a quiet "unavailable" below. The whole
            strip fades in with the hero — the figures never count up. */}
        <dl className="anim-enter anim-d3 mt-14 grid max-w-2xl grid-cols-1 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3">
          <Stat label="Ballasted projects" value={ballasted} />
          <Stat label="Total ballast" value={total} />
          <Stat label="Launches this week" value={week} />
        </dl>
        {!stats.available && (
          <p className="anim-enter anim-d3 mt-2 max-w-2xl text-xs text-text-faint">
            Live figures unavailable right now — reading from the chain failed. They&apos;ll fill in once it&apos;s
            reachable.
          </p>
        )}
      </Container>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <dd className="figure-primary text-2xl tabular-nums">{value}</dd>
      <dt className="metric-secondary mt-1">{label}</dt>
    </div>
  );
}

function Problem() {
  return (
    <Section>
      <SectionHeading>Every token is worth whatever the next buyer pays.</SectionHeading>
      <Prose>
        <p>
          That is the whole model. Bonding curves exist because there is nothing
          underneath to price against — so the market invents a price out of
          attention alone.
        </p>
        <p>
          It works until attention leaves. In July, the largest launchpad on
          Robinhood Chain collected roughly $12 million in fees, stopped launching
          tokens, and went quiet two days later. Nobody could see it coming, because
          there was nothing to see.
        </p>
      </Prose>
      <PullQuote>You cannot audit a vibe.</PullQuote>
    </Section>
  );
}

function Difference() {
  return (
    <Section muted>
      <SectionHeading>
        Robinhood Chain is the only chain where a token can be measured against
        something real.
      </SectionHeading>
      <Prose>
        <p>
          Tokenized equities and Chainlink price feeds are native here. That makes
          one number possible that no other launchpad can produce:
        </p>
      </Prose>
      <pre className="my-6 max-w-xl overflow-x-auto rounded-card border border-border bg-bg p-5 text-sm text-text-primary">
        <code>{`backing per token  =  treasury assets × live price  ÷  total supply`}</code>
      </pre>
      <Prose>
        <p>
          Projects deposit real tokenized assets into a treasury contract. BALLAST
          reads it, prices it, and shows it on every card, every chart, every
          portfolio row.
        </p>
        <p>
          This is not curation, a rating, or a seal of approval. It is arithmetic on
          public data.
        </p>
      </Prose>
    </Section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "1",
      title: "Ballast your launch",
      body: "Deposit tokenized T-bills, equities, or other allowlisted assets into your project treasury. Choose your withdrawal notice period: 7, 30, or 90 days.",
    },
    {
      n: "2",
      title: "It becomes public",
      body: "Your treasury contents, backing per token, and notice period appear on your project page from the moment you launch. So does the fact that you can withdraw, and how long that would take.",
    },
    {
      n: "3",
      title: "Withdrawals are announced first",
      body: "You can always take back what you put in. But announcing is mandatory and the delay is fixed at deploy time. Everyone sees the countdown before a single asset moves.",
    },
  ];
  return (
    <Section id="how-it-works">
      <SectionHeading>How it works</SectionHeading>
      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {steps.map((s) => (
          <div key={s.n} className="card p-6">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-bg font-semibold text-green">
              {s.n}
            </div>
            <h3 className="mt-4 font-semibold text-text-primary">{s.title}</h3>
            <p className="mt-2 text-sm text-text-secondary">{s.body}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 max-w-2xl text-lg text-text-primary">
        No treasury can be emptied overnight. Not because we promise it — because the
        contract will not execute it.
      </p>
    </Section>
  );
}

function WhatBallastIs() {
  const is = [
    "Real assets, held in a contract you can read yourself",
    "Priced by Chainlink, timestamped, shown live",
    "Split into what is locked forever and what the creator can withdraw",
    "Verifiable by anyone, without asking us",
  ];
  const isNot = [
    "A claim on anything. Holding a token gives you no right to these assets.",
    "A redemption right. There is no mechanism to exchange tokens for treasury assets.",
    "A price floor. A token can and will trade below its backing.",
    "A promise of return. Projects fail. Assets fall. Treasuries shrink.",
    "Our opinion of the project. We report the number. We do not vouch for anyone.",
  ];
  return (
    // NOT a buried disclaimer — full-size type on the page, per spec §4 & copy §4.
    <Section id="what-ballast-is" muted>
      <SectionHeading>What ballast is, and is not.</SectionHeading>
      <div className="mt-8 grid gap-5 md:grid-cols-2">
        <div className="card p-6">
          <h3 className="font-semibold text-green">Ballast is</h3>
          <ul className="mt-4 space-y-3">
            {is.map((t) => (
              <li key={t} className="flex gap-3 text-sm text-text-secondary">
                <span aria-hidden className="text-green">
                  +
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-6">
          <h3 className="font-semibold text-negative">Ballast is not</h3>
          <ul className="mt-4 space-y-3">
            {isNot.map((t) => (
              <li key={t} className="flex gap-3 text-sm text-text-secondary">
                <span aria-hidden className="text-negative">
                  −
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="mt-8 max-w-2xl text-lg text-text-primary">
        We show you what is there. What you do with that is yours.
      </p>
    </Section>
  );
}

function NotEveryProject() {
  return (
    <Section>
      <SectionHeading>Not every project needs ballast.</SectionHeading>
      <Prose>
        <p>
          Memes launch here too, with an empty treasury and a label that says so.
          That is not a warning — it is a fact, stated plainly, the same way a full
          treasury is.
        </p>
        <p>
          A token with no ballast is not a worse token. It is a different bet, and you
          should be able to tell which one you are making before you buy.
        </p>
      </Prose>
    </Section>
  );
}

function Audiences() {
  return (
    <Section muted>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="card p-8">
          <h2 className="font-serif text-xl font-semibold text-bone">Show your work.</h2>
          <p className="mt-4 text-sm text-text-secondary">
            If you have raised, if you hold a treasury, if you are building something
            with assets behind it — most launchpads give you no way to prove it. You
            end up sounding exactly like the project that raised nothing.
          </p>
          <p className="mt-4 text-sm text-text-secondary">
            Ballast is how you show the difference without asking anyone to trust you.
          </p>
          <Link
            href="/app/create"
            className="mt-6 inline-block rounded-button bg-green px-4 py-2 text-sm font-semibold text-bg hover:opacity-90"
          >
            Launch a project
          </Link>
        </div>
        <div className="card p-8">
          <h2 className="font-serif text-xl font-semibold text-bone">
            Know what you are holding.
          </h2>
          <p className="mt-4 text-sm text-text-secondary">
            Every project page shows backing per token, how much is locked
            permanently, how much the creator can withdraw and after how long, the
            creator&apos;s history across previous launches, and how much of past
            deposits they still hold.
          </p>
          <p className="mt-4 text-sm text-text-secondary">
            Your portfolio shows what share of your holdings sits on a verified
            treasury and what share does not.
          </p>
          <Link
            href="/app/discover"
            className="mt-6 inline-block rounded-button border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:border-text-muted"
          >
            Explore projects
          </Link>
        </div>
      </div>
    </Section>
  );
}

const FAQ = [
  {
    q: "Can I get the treasury assets if I hold the token?",
    a: "No. Holding a token gives you no claim, redemption right, or entitlement to any treasury asset. Ballast is disclosure, not ownership.",
  },
  {
    q: "Can a creator drain the treasury?",
    a: "A creator can withdraw only what they deposited themselves, and only after publicly announcing it and waiting out the notice period fixed when the project launched. Assets deposited by anyone else are locked permanently and cannot be withdrawn by anyone.",
  },
  {
    q: "What if I deposit ballast to a project?",
    a: "It is permanent. You cannot withdraw it, you receive nothing in return, and the project may still fail. Read the confirmation screen carefully — it is deliberately blunt.",
  },
  {
    q: "Why does the equity value sometimes stop updating?",
    a: "Tokenized equity feeds run 24/5 — regular, pre-market, post-market and overnight sessions — so weekday nights are covered. They rest on weekends, market holidays, and thin overnight windows, holding the last published price. When a feed is resting we show that last price with its timestamp, clearly marked, and never estimate, smooth, or forward-project a price we do not have.",
  },
  {
    q: "Can the notice period be changed after launch?",
    a: "No. It is immutable, set at deploy time, and visible on every project page.",
  },
  {
    q: "Is a high backing ratio good?",
    a: "It is a number, not a verdict. A token trading at 5× its backing may be overvalued or may reflect real expectations about the project. We show the figure and the 30-day average. The judgement is yours.",
  },
  {
    q: "Are you affiliated with Robinhood?",
    a: "No. BALLAST is an independent project built on Robinhood Chain. It is not affiliated with, endorsed by, or connected to Robinhood Markets, Inc.",
  },
];

function Faq() {
  return (
    <Section>
      <SectionHeading>FAQ</SectionHeading>
      <FaqList items={FAQ} />
    </Section>
  );
}

function FinalCta() {
  return (
    <section className="border-t border-border">
      <Container className="py-20 text-center">
        <h2 className="font-serif text-3xl font-semibold tracking-tight text-bone">
          Show your work, or know what you hold.
        </h2>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/app/discover"
            className="rounded-button bg-green px-5 py-3 font-semibold text-bg hover:opacity-90"
          >
            Explore ballasted projects
          </Link>
          <Link
            href="/docs/how-ballast-works"
            className="rounded-button border border-border px-5 py-3 font-semibold text-text-primary hover:border-text-muted"
          >
            Read the docs
          </Link>
        </div>
      </Container>
    </section>
  );
}

// ---- small presentational helpers -------------------------------------------

function Section({
  children,
  id,
  muted,
}: {
  children: React.ReactNode;
  id?: string;
  muted?: boolean;
}) {
  return (
    <section id={id} className={muted ? "border-b border-border bg-card/30" : "border-b border-border"}>
      <Container className="py-16 sm:py-20">
        <Reveal>{children}</Reveal>
      </Container>
    </section>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="max-w-3xl font-serif text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
      {children}
    </h2>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 max-w-2xl space-y-4 text-text-secondary">{children}</div>;
}

function PullQuote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-8 border-l-2 border-green pl-4 text-xl font-medium text-text-primary">
      {children}
    </p>
  );
}
