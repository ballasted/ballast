import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { shortAddress } from "@/lib/format";
import { getAdminLeaderboard } from "@/lib/creator-fund/adminData";
import { confirmedWinners } from "@/lib/creator-fund/confirmedWinners";
import {
  FLAG_REASON_LABEL,
  MAX_WINNERS,
  STATUS_LABEL,
  type AdminTokenEntry,
} from "@/lib/creatorFund";

export const metadata: Metadata = {
  title: "Creator Fund — Admin",
  robots: { index: false, follow: false },
};

// Admin-only review page. Gated by the SERVER-ONLY env var CREATOR_FUND_ADMIN: when
// it is not "true" the route 404s. Not linked anywhere public. Shows every candidate
// with all manual-review flags so the human can decide before confirming + paying.
export default function CreatorFundAdminPage() {
  if (process.env.CREATOR_FUND_ADMIN !== "true") notFound();

  const board = getAdminLeaderboard();
  const confirmed = new Set(confirmedWinners().map((w) => w.token.toLowerCase()));
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const when = (t: number | null) => (t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="eyebrow">Admin · not public</div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Creator Fund — review</h1>
        <p className="text-sm text-text-muted">
          Generated {when(board.meta.generatedAt)} · block {board.meta.lastScannedBlock} · confirmed{" "}
          {confirmed.size}/{MAX_WINNERS}
        </p>
      </header>

      {board.tokens.length === 0 ? (
        <div className="note note-neutral">No tracked tokens yet. Run the scanner.</div>
      ) : (
        <ul className="space-y-4">
          {board.tokens.map((t) => (
            <li key={t.token}>
              <AdminRow entry={t} confirmed={confirmed.has(t.token.toLowerCase())} usd={usd} when={when} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AdminRow({
  entry,
  confirmed,
  usd,
  when,
}: {
  entry: AdminTokenEntry;
  confirmed: boolean;
  usd: (n: number) => string;
  when: (t: number | null) => string;
}) {
  const statusTone: Record<string, string> = {
    qualified: "chip-accent",
    in_progress: "chip-neutral",
    disqualified_candidate: "chip-warning",
    expired: "chip-neutral",
  };
  const shownSwaps = entry.flaggedSwaps.slice(0, 25);
  const shownHolders = entry.flaggedHolders.slice(0, 25);

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        {entry.rank ? <span className="chip chip-accent tabular-nums">#{entry.rank}</span> : null}
        <a href={`/app/token/${entry.token}`} className="font-medium text-bone hover:text-green">
          {entry.symbol ? `$${entry.symbol}` : shortAddress(entry.token)}
        </a>
        <span className={`chip ${statusTone[entry.status] ?? "chip-neutral"}`}>{STATUS_LABEL[entry.status]}</span>
        {confirmed ? <span className="chip chip-accent">Confirmed</span> : null}
        {entry.funded ? <span className="chip chip-accent">Funded</span> : null}
        <span className="ml-auto text-xs text-text-faint">
          creator {shortAddress(entry.creator)} · treasury {shortAddress(entry.treasury)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Field label="Raw volume" value={usd(entry.rawVolumeUsd)} />
        <Field label="Excl. flagged" value={usd(entry.volumeExcludingFlaggedUsd)} />
        <Field label="Flagged vol" value={usd(entry.flaggedVolumeUsd)} />
        <Field label="Holders" value={String(entry.holders)} />
        <Field label="Vol milestone" value={when(entry.volumeMilestoneReachedTs)} />
        <Field label="Holders milestone" value={when(entry.holdersMilestoneReachedTs)} />
        <Field label="2nd milestone" value={when(entry.secondMilestoneReachedTs)} />
        <Field label="Quote assets" value={entry.quoteAssets.map((q) => q.symbol).join(", ") || "—"} />
      </dl>

      {entry.reviewNotes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-warning">
          {entry.reviewNotes.map((n, i) => (
            <li key={i}>⚠ {n}</li>
          ))}
        </ul>
      ) : null}

      {shownSwaps.length > 0 ? (
        <details className="mt-3">
          <summary className="section-label cursor-pointer">
            Flagged swaps ({entry.flaggedSwaps.length})
          </summary>
          <div className="mt-2 space-y-1 text-xs text-text-muted">
            {shownSwaps.map((s) => (
              <div key={`${s.txHash}-${s.logIndex}`} className="flex flex-wrap gap-2 tabular-nums">
                <span>{when(s.blockTs)}</span>
                <span className="uppercase">{s.side}</span>
                <span>{usd(s.usd)}</span>
                <span>{shortAddress(s.trader)}</span>
                <span className="text-warning">{s.reasons.map((r) => FLAG_REASON_LABEL[r]).join(", ")}</span>
              </div>
            ))}
            {entry.flaggedSwaps.length > shownSwaps.length ? (
              <div>+{entry.flaggedSwaps.length - shownSwaps.length} more</div>
            ) : null}
          </div>
        </details>
      ) : null}

      {shownHolders.length > 0 ? (
        <details className="mt-3">
          <summary className="section-label cursor-pointer">
            Flagged holder clusters ({entry.flaggedHolders.length})
          </summary>
          <div className="mt-2 space-y-1 text-xs text-text-muted">
            {shownHolders.map((h) => (
              <div key={h.holder} className="flex flex-wrap gap-2">
                <span>{shortAddress(h.holder)}</span>
                <span className="text-warning">cluster of {h.clusterSize}</span>
                <span>funded by {shortAddress(h.fundedBy)}</span>
              </div>
            ))}
            {entry.flaggedHolders.length > shownHolders.length ? (
              <div>+{entry.flaggedHolders.length - shownHolders.length} more</div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="section-label">{label}</dt>
      <dd className="tabular-nums text-bone">{value}</dd>
    </div>
  );
}
