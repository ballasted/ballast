"use client";

import type { Address } from "viem";
import { useSecurityCheck } from "@/hooks/useSecurityCheck";
import { formatEt } from "@/lib/marketHours";
import { cn } from "@/lib/cn";
import type { CheckStatus } from "@/lib/goplus";

type PillStatus = CheckStatus | "info";

// Live third-party security scan (GoPlus) — same shape as VerificationPanel:
// one row per check, a chip, a tooltip, and a link a visitor can independently
// open. "Unknown" is a real, distinct state (GoPlus omits a field entirely
// rather than reporting a false "0") and must never render as a green pass —
// see lib/goplus.ts for why. The one non-GoPlus row (sell-exact-out) is a real,
// permanent, documented hook limitation (docs/PROTOCOL_CONTROLS.md), labeled
// "By design" rather than folded into Pass/Fail/Unknown so it can't be misread
// as either a vulnerability or a clean bill of health.
export function SecurityChecksPanel({ token }: { token?: Address }) {
  const { data, result, isLoading } = useSecurityCheck(token);

  if (!token) return null;
  if (isLoading && !data) {
    return (
      <section className="card p-4">
        <h2 className="section-label">Security checks</h2>
        <div className="mt-3 space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-surface-raised" />
          ))}
        </div>
      </section>
    );
  }

  const proofHref = data?.apiUrl;
  const unreachable = !data?.available;
  const checkedAt = data?.fetchedAt ? formatEt(data.fetchedAt) : undefined;

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-label">Security checks</h2>
        {!unreachable && result && !result.scanned && <span className="chip chip-neutral">Not yet scanned</span>}
      </div>

      {unreachable ? (
        <ul className="mt-3 divide-y divide-border">
          <Row label="Source verified" status="unknown" value="Check unavailable" tip="GoPlus is_open_source." />
          <Row label="Honeypot" status="unknown" value="Check unavailable" tip="GoPlus is_honeypot." />
          <Row label="Buy tax" status="unknown" value="Check unavailable" tip="GoPlus buy_tax." />
          <Row label="Sell tax" status="unknown" value="Check unavailable" tip="GoPlus sell_tax." />
          <Row label="Can be bought" status="unknown" value="Check unavailable" tip="GoPlus cannot_buy." />
          <Row label="Transfer pausable" status="unknown" value="Check unavailable" tip="GoPlus transfer_pausable." />
        </ul>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          <Row
            label="Source verified"
            status={result?.verifiedSource.status ?? "unknown"}
            value={result?.verifiedSource.value ?? "Not reported"}
            tip="GoPlus is_open_source."
            href={proofHref}
          />
          <Row
            label="Honeypot"
            status={result?.honeypot.status ?? "unknown"}
            value={result?.honeypot.value ?? "Not reported"}
            tip="GoPlus is_honeypot. Absent from GoPlus's response means not yet classified — never read as a pass."
            href={proofHref}
          />
          <Row
            label="Buy tax"
            status={result?.buyTax.status ?? "unknown"}
            value={result?.buyTax.value ?? "Not reported"}
            tip="GoPlus buy_tax."
            href={proofHref}
          />
          <Row
            label="Sell tax"
            status={result?.sellTax.status ?? "unknown"}
            value={result?.sellTax.value ?? "Not reported"}
            tip="GoPlus sell_tax."
            href={proofHref}
          />
          <Row
            label="Can be bought"
            status={result?.cannotBuy.status ?? "unknown"}
            value={result?.cannotBuy.value ?? "Not reported"}
            tip="GoPlus cannot_buy."
            href={proofHref}
          />
          <Row
            label="Transfer pausable"
            status={result?.transferPausable.status ?? "unknown"}
            value={result?.transferPausable.value ?? "Not reported"}
            tip="GoPlus transfer_pausable."
            href={proofHref}
          />
          <Row
            label="Sell-exact-out"
            status="info"
            pillLabel="By design"
            value="Not supported"
            tip="BallastHook.sol intentionally reverts sell-exact-out swaps — a documented limitation, not a vulnerability."
            href="/docs/protocol-controls"
          />
        </ul>
      )}

      <p className="mt-3 text-xs text-text-faint">
        {unreachable ? "GoPlus unreachable" : `via GoPlus${checkedAt ? `, checked ${checkedAt}` : ""}`}
        {proofHref && (
          <>
            {" · "}
            <a href={proofHref} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-text-secondary">
              Raw response ↗
            </a>
          </>
        )}
      </p>
    </section>
  );
}

function Row({
  label,
  status,
  value,
  tip,
  href,
  pillLabel,
}: {
  label: string;
  status: PillStatus;
  value: string;
  tip: string;
  href?: string;
  pillLabel?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="flex min-w-0 items-center gap-1.5 text-text-secondary">
        <span className="truncate">{label}</span>
        <span aria-hidden title={tip} className="cursor-help text-text-faint">
          ⓘ
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <StatusPill status={status} label={pillLabel} />
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="max-w-[10rem] truncate text-xs text-text-faint hover:text-green" title={value}>
            {value}
          </a>
        ) : (
          <span className="max-w-[12rem] truncate text-xs text-text-faint" title={value}>
            {value}
          </span>
        )}
      </span>
    </li>
  );
}

function StatusPill({ status, label }: { status: PillStatus; label?: string }) {
  return (
    <span
      className={cn(
        "chip",
        status === "pass" ? "chip-accent" : status === "fail" ? "chip-negative" : "chip-neutral",
      )}
    >
      {label ?? (status === "pass" ? "Pass" : status === "fail" ? "Fail" : "Unknown")}
    </span>
  );
}
