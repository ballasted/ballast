"use client";

import type { PendingWithdrawal } from "@/hooks/useBacking";
import { formatDuration } from "@/lib/format";
import { formatEt } from "@/lib/marketHours";

// Amber banner shown ABOVE everything on the token/project page when a creator
// withdrawal is announced (build-spec §9). Countdown + execution date, so anyone
// sees intent before a single asset moves.
export function PendingWithdrawalBanner({ pending, now }: { pending: PendingWithdrawal; now: number }) {
  const unlockAt = Number(pending.unlockAt);
  const remaining = now > 0 ? unlockAt - now : 0;
  const executable = now > 0 && remaining <= 0;

  return (
    <div className="rounded-card border border-warning-border bg-warning-bg p-4">
      <div className="flex items-center gap-2 text-warning">
        <span aria-hidden>⚠</span>
        <span className="font-semibold">Creator withdrawal announced</span>
      </div>
      <p className="mt-2 text-sm text-text-secondary">
        {formatAmount(pending.amount)} of one treasury asset is scheduled to be
        withdrawn.{" "}
        {executable ? (
          <span className="text-warning">The notice period has elapsed — it can be executed now.</span>
        ) : now > 0 ? (
          <>
            Executable in <span className="font-semibold text-text-primary">{formatDuration(remaining)}</span>, on{" "}
            {formatEt(unlockAt)}.
          </>
        ) : (
          <>Executable on {formatEt(unlockAt)}.</>
        )}
      </p>
    </div>
  );
}

function formatAmount(raw: bigint): string {
  // Asset decimals unknown here; show the raw 18-dec assumption compactly.
  const v = Number(raw) / 1e18;
  return v.toLocaleString("en", { maximumFractionDigits: 6 });
}
