"use client";

import { useMemo } from "react";
import { useNow } from "@/hooks/useNow";
import { shortAddress } from "@/lib/format";
import {
  CREATOR_FUND_DISCLAIMER,
  MAX_WINNERS,
  MILESTONE_HOLDERS,
  MILESTONE_VOLUME_USD,
  MILESTONE_WINDOW_DAYS,
  PRIZE_USD,
  TOTAL_CAP_USD,
  isCreatorFundEnabled,
  progressPct,
  remainingSpots,
  windowDaysLeft,
  type PublicLeaderboard,
  type PublicTokenEntry,
} from "@/lib/creatorFund";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function CreatorFundView({
  board,
  confirmedCount,
}: {
  board: PublicLeaderboard;
  confirmedCount: number;
}) {
  const now = useNow();
  const started = board.meta.campaignStart > 0 && (now === 0 || now >= board.meta.campaignStart);

  // Public board shows the race: qualified first (by rank), then in-progress.
  const rows = useMemo(() => {
    const show = board.tokens.filter((t) => t.status === "qualified" || t.status === "in_progress");
    return show.sort((a, b) => {
      if (a.status !== b.status) return a.status === "qualified" ? -1 : 1;
      if (a.status === "qualified") return (a.rank ?? 99) - (b.rank ?? 99);
      return b.rawVolumeUsd - a.rawVolumeUsd;
    });
  }, [board.tokens]);

  const spotsLeft = remainingSpots(confirmedCount);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="eyebrow">Campaign</div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Creator Fund</h1>
      </header>

      {!isCreatorFundEnabled ? (
        <div className="note note-neutral">The Creator Fund is not live yet.</div>
      ) : (
        <>
          {/* Spots + rules */}
          <section className="grid gap-4 sm:grid-cols-3">
            <div className="card p-4">
              <div className="section-label">Spots left</div>
              <div className="figure-primary mt-1 tabular-nums">
                {spotsLeft}
                <span className="metric-secondary"> / {MAX_WINNERS}</span>
              </div>
              <div className="metric-secondary mt-1">{usd(TOTAL_CAP_USD)} total</div>
            </div>
            <div className="card p-4">
              <div className="section-label">Prize</div>
              <div className="figure-primary mt-1 tabular-nums">{usd(PRIZE_USD)}</div>
              <div className="metric-secondary mt-1">in stock tokens, to the treasury</div>
            </div>
            <div className="card p-4">
              <div className="section-label">To qualify</div>
              <div className="mt-1 text-sm text-text-muted">
                {usd(MILESTONE_VOLUME_USD)} volume · {MILESTONE_HOLDERS} holders
              </div>
              <div className="metric-secondary mt-1">within {MILESTONE_WINDOW_DAYS} days of launch</div>
            </div>
          </section>

          <Rules />

          <div className="note note-neutral">{CREATOR_FUND_DISCLAIMER}</div>

          {/* Leaderboard */}
          <section className="space-y-3">
            <h2 className="section-label">Leaderboard</h2>
            {!started ? (
              <div className="note note-neutral">The campaign hasn&apos;t started yet. Check back soon.</div>
            ) : rows.length === 0 ? (
              <div className="note note-neutral">No eligible tokens yet.</div>
            ) : (
              <ul className="space-y-3">
                {rows.map((t) => (
                  <li key={t.token}>
                    <LeaderboardRow entry={t} now={now} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Rules() {
  return (
    <section className="card p-4">
      <h2 className="section-label">Rules</h2>
      <ul className="mt-2 space-y-1.5 text-sm text-text-muted">
        <li>• Tokens launched on Ballast after the campaign start, with an NVDA, SPY or SGOV pool.</li>
        <li>
          • Reach {usd(MILESTONE_VOLUME_USD)} cumulative swap volume and {MILESTONE_HOLDERS} holders within{" "}
          {MILESTONE_WINDOW_DAYS} days of launch.
        </li>
        <li>• First {MAX_WINNERS} tokens to reach both, ordered by when the second milestone was met.</li>
        <li>• One entry per creator.</li>
        <li>• Prize: {usd(PRIZE_USD)} in stock tokens deposited into the token&apos;s treasury.</li>
      </ul>
    </section>
  );
}

function Bar({ value, target, tone }: { value: number; target: number; tone: "green" | "muted" }) {
  const pct = progressPct(value, target);
  const fill = tone === "green" ? "bg-green" : "bg-text-faint";
  return (
    <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-border" aria-hidden>
      <div className={`bar-grow ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function LeaderboardRow({ entry, now }: { entry: PublicTokenEntry; now: number }) {
  const qualified = entry.status === "qualified";
  const daysLeft = windowDaysLeft(entry.launchTs, now || Math.floor(entry.windowEndTs));
  const volPct = Math.round(progressPct(entry.rawVolumeUsd, MILESTONE_VOLUME_USD));
  const holdPct = Math.round(progressPct(entry.holders, MILESTONE_HOLDERS));

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {qualified && entry.rank ? (
            <span className="chip chip-accent tabular-nums">#{entry.rank}</span>
          ) : null}
          <a
            href={`/app/token/${entry.token}`}
            className="font-medium text-bone hover:text-green"
          >
            {entry.symbol ? `$${entry.symbol}` : shortAddress(entry.token)}
          </a>
          {qualified ? (
            <span className="chip chip-accent">Qualified</span>
          ) : (
            <span className="chip chip-neutral tabular-nums">{daysLeft}d left</span>
          )}
          {entry.funded ? (
            <a
              href={`${BLOCKSCOUT}/tx/${entry.funded.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="chip chip-accent"
              title="Prize deposited to treasury"
            >
              Funded
            </a>
          ) : null}
        </div>
        <div className="text-right text-xs text-text-faint">
          by {shortAddress(entry.creator)}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="section-label">Volume</span>
            <span className="metric-secondary tabular-nums">
              {usd(entry.rawVolumeUsd)} / {usd(MILESTONE_VOLUME_USD)} · {volPct}%
            </span>
          </div>
          <Bar value={entry.rawVolumeUsd} target={MILESTONE_VOLUME_USD} tone="green" />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="section-label">Holders</span>
            <span className="metric-secondary tabular-nums">
              {entry.holders} / {MILESTONE_HOLDERS} · {holdPct}%
            </span>
          </div>
          <Bar value={entry.holders} target={MILESTONE_HOLDERS} tone="green" />
        </div>
      </div>
    </div>
  );
}
