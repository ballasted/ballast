"use client";

import Link from "next/link";
import type { Address } from "viem";
import { useVerification } from "@/hooks/useVerification";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";
import { activeChain } from "@/lib/chain";

type CheckStatus = "pass" | "fail" | "unavailable";

// Live verification — one row per check: label, status, value. No sentence per
// row; the plain-language explanation lives in docs (linked at the bottom, and
// in each row's title tooltip). Every value is a fresh chain/Blockscout read
// from /api/verify — nothing here is derived or cached client-side beyond
// react-query's own 20s staleTime.
export function VerificationPanel({ token }: { token?: Address }) {
  const { data, isLoading } = useVerification(token);

  if (!token) return null;
  if (isLoading && !data) {
    return (
      <section className="card p-4">
        <h2 className="section-label">Verification</h2>
        <div className="mt-3 space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-surface-raised" />
          ))}
        </div>
      </section>
    );
  }
  if (!data || !data.isBallastLaunch || !data.checks) return null;

  const c = data.checks;
  // Label suffix only when there's more than one pool — a single-pool launch
  // (the common case) keeps the exact same row labels as before.
  const suffix = (symbol: string) => (c.pools.length > 1 ? ` (${symbol})` : "");

  return (
    <section className="card p-4">
      <h2 className="section-label">Verification</h2>
      <ul className="mt-3 divide-y divide-border">
        <Row
          label="Token source"
          status={c.sourceVerifiedToken.status}
          value={c.sourceVerifiedToken.value}
          tip="Published source matching bytecode, on Blockscout."
          href={c.sourceVerifiedToken.explorerUrl}
        />
        <Row
          label="Treasury source"
          status={c.sourceVerifiedTreasury.status}
          value={c.sourceVerifiedTreasury.value}
          tip="Same check, for the treasury contract."
          href={c.sourceVerifiedTreasury.explorerUrl || undefined}
        />
        <Row
          label="Mint authority"
          status={c.mintAuthority.status}
          value={c.mintAuthority.value}
          tip="No mint function exists in the source."
        />
        <Row
          label="Mutable params"
          status={c.mutableParams.status}
          value={c.mutableParams.items.join("; ")}
          tip="Only project metadata can change post-launch."
        />
        {!c.graduated && (
          <Row label="Liquidity locked" status="fail" value="Not graduated — no pool exists yet" tip="Pool position has no removal function." />
        )}
        {c.pools.map((p) => (
          <Row
            key={`liq-${p.quoteAsset}`}
            label={`Liquidity locked${suffix(p.symbol)}`}
            status={p.liquidityLocked.status}
            value={p.liquidityLocked.value}
            tip="Pool position has no removal function."
            href={p.hookAddress ? `${activeChain.blockExplorers.default.url}/address/${p.hookAddress}` : undefined}
          />
        ))}
        <Row
          label="Creator allocation"
          status={c.creatorAllocation.status}
          value={c.creatorAllocation.value}
          tip="Launch grants creators 0% by design."
        />
        {c.backingAssets.map((a) => (
          <Row
            key={a.address}
            label={`Backing: ${a.symbol ?? shortAddress(a.address)}`}
            status={a.status}
            value={a.status === "pass" ? "Matches registry" : a.status === "fail" ? "Does not match registry" : "Unavailable"}
            tip="Checked by address against AssetRegistry, never ticker."
          />
        ))}
        {!c.graduated && (
          <Row label="Sell simulation" status="unavailable" value="Not graduated yet" tip="Live quote through the real pool, not a cached assumption." />
        )}
        {c.pools.map((p) => (
          <Row
            key={`sell-${p.quoteAsset}`}
            label={`Sell simulation${suffix(p.symbol)}`}
            status={p.sellSimulation.status}
            value={p.sellSimulation.value}
            tip="Live quote through the real pool, not a cached assumption. An empty quote side (nobody's bought yet) is not the same as a real failure."
          />
        ))}
      </ul>
      <p className="mt-3 text-xs text-text-faint">
        Live reads, refreshed every 30s.{" "}
        <Link href="/docs/verify-a-treasury" className="underline underline-offset-2 hover:text-text-secondary">
          What each row means
        </Link>
        .
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
}: {
  label: string;
  status: CheckStatus;
  value: string;
  tip: string;
  href?: string;
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
        <StatusPill status={status} />
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

function StatusPill({ status }: { status: CheckStatus }) {
  return (
    <span
      className={cn(
        "chip",
        status === "pass" ? "chip-accent" : status === "fail" ? "chip-negative" : "chip-neutral",
      )}
    >
      {status === "pass" ? "Pass" : status === "fail" ? "Fail" : "Unavailable"}
    </span>
  );
}
