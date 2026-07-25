"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { ballastFactoryAbi } from "@/lib/abis";
import { FACTORY_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { ConnectButton } from "@/components/app/ConnectButton";

// Shown on a token page when the token is registered but its pool was never seeded
// (graduated == false) — a half-launched, dead token. `graduate()` is permissionless,
// so any connected wallet can finish it. Idempotent + timeout-safe: it prechecks
// graduated() and, on a lost receipt, tells the user to check Blockscout rather
// than blindly retrying (Part B).
type Phase = "idle" | "pending" | "confirming" | "lost" | "error" | "done";

export function ResumeLaunchPanel({ token, symbol }: { token: Address; symbol?: string }) {
  const { isConnected } = useAccount();
  const { wrongNetwork, switchToRobinhood, isSwitching } = useNetworkGuard();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: activeChain.id });

  const [phase, setPhase] = useState<Phase>("idle");
  const [hash, setHash] = useState<`0x${string}`>();
  const [err, setErr] = useState<string>();

  const explorer = activeChain.blockExplorers.default.url;

  async function resume() {
    if (!FACTORY_ADDRESS || !publicClient) return;
    setErr(undefined);
    // Precheck — maybe a prior (lost) tx already seeded it.
    try {
      const g = (await publicClient.readContract({
        address: FACTORY_ADDRESS,
        abi: ballastFactoryAbi,
        functionName: "graduated",
        args: [token],
      })) as boolean;
      if (g) {
        setPhase("done");
        return;
      }
    } catch {
      /* read failed — fall through and let the write attempt (it reverts if already graduated) */
    }
    setPhase("pending");
    let h: `0x${string}`;
    try {
      h = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: ballastFactoryAbi,
        functionName: "graduate",
        args: [token],
        chainId: activeChain.id,
      });
    } catch (e) {
      setErr(decodeTxError(e));
      setPhase("error");
      return;
    }
    setHash(h);
    setPhase("confirming");
    const outcome = await pollReceipt(publicClient, h);
    if (outcome.status === "lost") {
      setPhase("lost");
      return;
    }
    if (outcome.status === "reverted") {
      setErr("Transaction reverted on-chain — it may already be seeded.");
      setPhase("error");
      return;
    }
    setPhase("done");
  }

  return (
    <section className="card border-accent p-5">
      <h2 className="font-serif text-lg font-semibold text-bone">Launch incomplete — pool not seeded</h2>
      <p className="mt-1 text-sm text-text-secondary">
        ${symbol || "This token"} deployed, but its liquidity pool was never seeded, so it has no market price yet.
        Seeding is permissionless — anyone can finish it. This locks the LP permanently and cannot be undone.
      </p>

      {phase === "done" ? (
        <div className="mt-4 rounded-input border border-green/40 bg-green-bg p-3 text-sm">
          <div className="font-semibold text-green">Pool seeded ✓</div>
          <p className="mt-1 text-text-secondary">The market is live. Reload to see the price.</p>
          <button className="btn-primary mt-3 w-full" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : phase === "lost" ? (
        <div className="mt-4 rounded-input border border-warning-border bg-warning-bg p-3 text-sm">
          <div className="font-semibold text-warning">We lost track of this transaction</div>
          <p className="mt-1 text-text-secondary">
            It may still have succeeded — check Blockscout before retrying, so you don&apos;t seed twice.
          </p>
          {hash && (
            <a
              className="mt-2 block break-all font-mono text-xs text-text-primary underline underline-offset-2"
              href={`${explorer}/tx/${hash}`}
              target="_blank"
              rel="noreferrer"
            >
              {hash} ↗
            </a>
          )}
          <button className="btn-secondary mt-3 w-full" onClick={resume}>
            I checked — re-check &amp; resume
          </button>
        </div>
      ) : !isConnected ? (
        <div className="mt-4">
          <ConnectButton />
        </div>
      ) : wrongNetwork ? (
        <button className="btn-primary mt-4 w-full" onClick={() => void switchToRobinhood()} disabled={isSwitching}>
          {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
        </button>
      ) : (
        <>
          <button
            className="btn-primary mt-4 w-full"
            onClick={resume}
            disabled={phase === "pending" || phase === "confirming"}
          >
            {phase === "pending"
              ? "Confirm in your wallet…"
              : phase === "confirming"
                ? "Waiting for confirmation…"
                : "Resume launch — seed the pool"}
          </button>
          {phase === "confirming" && hash && (
            <a
              className="mt-2 block break-all text-center text-xs text-text-faint hover:text-text-secondary"
              href={`${explorer}/tx/${hash}`}
              target="_blank"
              rel="noreferrer"
            >
              Waiting for confirmation · view on Blockscout ↗
            </a>
          )}
          {err && <p className="mt-2 text-center text-xs text-negative">{err}</p>}
        </>
      )}
    </section>
  );
}
