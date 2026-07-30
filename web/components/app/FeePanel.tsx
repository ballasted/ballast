"use client";

import { useAccount } from "wagmi";
import { formatUnits, type Address } from "viem";
import { useAccruedFees } from "@/hooks/useAccruedFees";
import { activeChain } from "@/lib/chain";
import { formatUsd } from "@/lib/format";

function fmtWeth(v?: bigint): string {
  if (v === undefined) return "…";
  return Number(formatUnits(v, 18)).toLocaleString("en", { maximumFractionDigits: 6 });
}

// The connected wallet's accrued WETH swap fees, with a Claim button. Scoped to the
// connected account (owed is per-recipient). Serves creators, the platform vault,
// and referrers alike — all claim through the same path.
//
// `requireAccount` gates rendering to one address (the token page passes the
// creator, so only the creator sees it there). `alwaysShow` keeps the panel up even
// at a zero balance (creators should see where fees will land); otherwise it hides
// when there is nothing to claim, so it never nags a wallet with no fees.
export function FeePanel({
  requireAccount,
  alwaysShow,
  title = "Creator fees",
  note,
}: {
  requireAccount?: Address;
  alwaysShow?: boolean;
  title?: string;
  note?: string;
}) {
  const { address } = useAccount();
  const f = useAccruedFees(address);

  if (!address || !f.isConfigured) return null;
  if (requireAccount && address.toLowerCase() !== requireAccount.toLowerCase()) return null;
  // Self-hide when there's nothing to claim — unless told to always show, or we're
  // mid/post-claim (so the confirmation stays visible after owed refetches to 0).
  const empty = f.accruedWeth === 0n;
  if (empty && !alwaysShow && f.phase === "idle") return null;

  const busy = f.phase === "claiming";

  return (
    <section className="card border-accent p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">{title}</h2>

      <div className="mt-3 flex items-baseline gap-2">
        <span key={fmtWeth(f.accruedWeth)} className="figure-primary anim-fade text-3xl">
          {fmtWeth(f.accruedWeth)}
        </span>
        <span className="metric-secondary">WETH accrued</span>
      </div>
      <div className="metric-secondary mt-0.5">
        {f.accruedUsd1e18 !== undefined ? `≈ ${formatUsd(f.accruedUsd1e18)}` : "USD equivalent unavailable"}
      </div>

      <p className="mt-3 text-xs text-text-faint">
        {note ??
          "Your share of the 1% WETH swap fee, accrued across all your BALLAST launches. One claim sweeps the full balance to your wallet as WETH."}
      </p>
      {f.claimSpansHooks && f.phase !== "success" && (
        <p className="mt-1 text-xs text-text-faint">
          Some of this accrued on an earlier pool version, so claiming will ask for two confirmations —
          one per version. Both land in your wallet.
        </p>
      )}

      {f.phase === "success" ? (
        <div className="mt-4 space-y-2 text-center">
          <p className="text-sm text-green">Claim confirmed — WETH is in your wallet.</p>
          {f.txHash && (
            <a
              className="text-xs text-text-faint hover:text-text-secondary"
              href={`${activeChain.blockExplorers.default.url}/tx/${f.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View on Blockscout ↗
            </a>
          )}
        </div>
      ) : (
        <button
          className="btn-primary mt-4 w-full"
          disabled={busy || empty || f.accruedWeth === undefined}
          onClick={f.claim}
        >
          {busy ? "Claiming…" : empty ? "Nothing to claim yet" : `Claim ${fmtWeth(f.accruedWeth)} WETH`}
        </button>
      )}
      {f.error && <p className="mt-2 text-center text-xs text-negative">{f.error}</p>}
    </section>
  );
}
