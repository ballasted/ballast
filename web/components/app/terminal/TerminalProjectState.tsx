"use client";

import type { Address } from "viem";
import type { PendingWithdrawal } from "@/hooks/useBacking";
import { activeChain } from "@/lib/chain";
import { shortAddress, formatDuration } from "@/lib/format";
import { cn } from "@/lib/cn";

// Project state — the single most useful thing a trader can know that no other
// terminal shows: what the creator can do, and whether a withdrawal is in flight.
// Creator holding is 0% on every token, always — the constant is the point.
export function TerminalProjectState({
  creator,
  treasury,
  graduated,
  hasPool,
  noticePeriod,
  pending,
  now,
}: {
  creator?: Address;
  treasury?: Address;
  graduated: boolean;
  hasPool: boolean;
  noticePeriod?: bigint; // seconds; immutable per treasury
  pending?: PendingWithdrawal;
  now: number;
}) {
  const explorer = activeChain.blockExplorers.default.url;
  const secsToUnlock = pending && now > 0 ? Number(pending.unlockAt) - now : undefined;

  return (
    <section className="card p-4">
      <h2 className="section-label">Project state</h2>

      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Creator">
          {creator ? (
            <a href={`${explorer}/address/${creator}`} target="_blank" rel="noreferrer" className="font-mono text-text-primary hover:text-green">
              {shortAddress(creator)}
            </a>
          ) : (
            <span className="text-text-faint">—</span>
          )}
        </Row>
        <Row label="Creator holding">
          <span className="font-semibold text-green">0%</span>
        </Row>
        <Row label="Liquidity">
          <span className="text-text-secondary">{graduated || hasPool ? "Seeded & locked" : "Not seeded yet"}</span>
        </Row>
        <Row label="Withdrawal notice">
          <span className="text-text-secondary">
            {noticePeriod !== undefined ? formatDuration(Number(noticePeriod)) : "—"}
          </span>
        </Row>
      </dl>

      {pending ? (
        <div className="mt-3 rounded-input border border-warning-border bg-warning-bg px-3 py-2 text-xs">
          <div className="font-medium text-warning">Withdrawal announced</div>
          <p className="mt-1 text-text-secondary">
            The creator has announced a withdrawal of creator-deposited assets.{" "}
            {secsToUnlock !== undefined && secsToUnlock > 0
              ? `It can execute in ${formatDuration(secsToUnlock)}.`
              : "The notice period has elapsed; it can execute now."}{" "}
            Only what the creator deposited can be withdrawn — third-party deposits are locked forever.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-text-faint">
          No withdrawal announced. The creator can only ever withdraw what they themselves deposited, and only after the
          immutable notice period above.
        </p>
      )}

      <p className="mt-2 text-[11px] text-text-faint">
        Creator holding is 0% on every BALLAST token — no presale, no team allocation, no vesting. The notice period is
        fixed at deploy and cannot be changed.
      </p>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between gap-2")}>
      <dt className="text-text-faint">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
