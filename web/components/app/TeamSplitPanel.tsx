"use client";

import { useState } from "react";
import { type Address, isAddress, formatUnits, zeroAddress } from "viem";
import { useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { creatorSplitterFactoryAbi, creatorSplitterAbi } from "@/lib/abis";
import {
  CREATOR_SPLITTER_FACTORY_ADDRESS,
  isCreatorSplitterConfigured,
  WETH_ADDRESS,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

const CHAIN_ID = activeChain.id;

type Row = { address: string; pct: string };

/** Team-split tool for the creator fee bucket. Create an immutable splitter
 *  (up to 4 recipients by %), then release each recipient's share. Hidden unless
 *  NEXT_PUBLIC_CREATOR_SPLITTER_FACTORY is set. Standalone, not a Create step:
 *  the fresh-launch flow can't auto-install a splitter (realCreator is immutable),
 *  so a creator uses the splitter address as their payout wallet where settable. */
export function TeamSplitPanel() {
  const factory = CREATOR_SPLITTER_FACTORY_ADDRESS;
  const [rows, setRows] = useState<Row[]>([
    { address: "", pct: "" },
    { address: "", pct: "" },
  ]);
  const [lookup, setLookup] = useState("");

  const create = useWriteContract();
  const createReceipt = useWaitForTransactionReceipt({ hash: create.data });

  if (!isCreatorSplitterConfigured || !factory) return null;

  const pctSum = rows.reduce((n, r) => n + (parseFloat(r.pct) || 0), 0);
  const addrsValid = rows.every((r) => isAddress(r.address));
  const canCreate =
    rows.length >= 1 &&
    rows.length <= 4 &&
    addrsValid &&
    Math.abs(pctSum - 100) < 1e-9 &&
    rows.every((r) => (parseFloat(r.pct) || 0) > 0) &&
    !create.isPending &&
    !createReceipt.isLoading;

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function onCreate() {
    if (!factory) return;
    // Convert % to bps; fix any rounding so the sum is exactly 10,000.
    const bps = rows.map((r) => Math.round((parseFloat(r.pct) || 0) * 100));
    const drift = 10_000 - bps.reduce((a, b) => a + b, 0);
    const last = bps.length - 1;
    bps[last] = (bps[last] ?? 0) + drift;
    await create.writeContractAsync({
      address: factory,
      abi: creatorSplitterFactoryAbi,
      functionName: "create",
      args: [rows.map((r) => r.address as Address), bps.map((b) => b)],
      chainId: CHAIN_ID,
    });
  }

  const lookupAddr = isAddress(lookup) ? (lookup as Address) : undefined;

  return (
    <div className="card space-y-4">
      <div className="section-label">Team split · creator bucket</div>
      <p className="note">
        Split ONLY the creator fee bucket across up to 4 wallets. Recipients and
        shares are fixed when you create the splitter and can never change — to
        change them, create a new one. Fees can be zero. Holding a token gives no
        claim, redemption right, or entitlement to treasury assets.
      </p>

      {/* create */}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="0x recipient"
              value={r.address}
              onChange={(e) => setRow(i, { address: e.target.value })}
            />
            <input
              className="input w-20"
              inputMode="decimal"
              placeholder="%"
              value={r.pct}
              onChange={(e) => setRow(i, { pct: e.target.value })}
            />
            {rows.length > 1 && (
              <button
                className="btn"
                type="button"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between">
          {rows.length < 4 ? (
            <button className="btn" type="button" onClick={() => setRows((rs) => [...rs, { address: "", pct: "" }])}>
              + recipient
            </button>
          ) : (
            <span />
          )}
          <span className={cn("text-xs", Math.abs(pctSum - 100) < 1e-9 ? "text-white/50" : "text-amber-400")}>
            {pctSum.toFixed(2)}% / 100%
          </span>
        </div>
        <button className="btn btn-primary w-full" onClick={onCreate} disabled={!canCreate}>
          {create.isPending || createReceipt.isLoading ? "Confirming…" : "Create team split"}
        </button>
        {createReceipt.isSuccess && (
          <p className="text-xs text-[#00C805]">
            Splitter created. Use its address (from the tx logs) as your creator payout wallet where that is
            settable.
          </p>
        )}
      </div>

      {/* manage */}
      <div className="space-y-2 border-t border-white/10 pt-3">
        <div className="eyebrow">Manage an existing splitter</div>
        <input
          className="input w-full"
          placeholder="0x splitter address"
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
        />
        {lookupAddr && <SplitterManager splitter={lookupAddr} />}
      </div>
    </div>
  );
}

function SplitterManager({ splitter }: { splitter: Address }) {
  const weth = WETH_ADDRESS;
  const base = { address: splitter, abi: creatorSplitterAbi, chainId: CHAIN_ID } as const;

  const rec = useReadContract({ ...base, functionName: "recipients" });
  const recipients = (rec.data as readonly Address[] | undefined) ?? [];

  // Releasable WETH + ETH per recipient.
  const releasable = useReadContracts({
    allowFailure: true,
    contracts: recipients.flatMap((r) => [
      { ...base, functionName: "releasable", args: [weth ?? zeroAddress, r] } as const,
      { ...base, functionName: "releasable", args: [zeroAddress, r] } as const,
    ]),
    query: { enabled: recipients.length > 0 },
  });

  const release = useWriteContract();
  const releaseReceipt = useWaitForTransactionReceipt({ hash: release.data });
  const busy = release.isPending || releaseReceipt.isLoading;

  if (recipients.length === 0) {
    return <p className="note">No recipients found — not a splitter, or not on this chain.</p>;
  }

  return (
    <div className="space-y-2">
      {recipients.map((r, i) => {
        const wethOwed = (releasable.data?.[i * 2]?.result as bigint | undefined) ?? 0n;
        const ethOwed = (releasable.data?.[i * 2 + 1]?.result as bigint | undefined) ?? 0n;
        return (
          <div key={r} className="flex items-center justify-between text-sm">
            <span>{shortAddress(r)}</span>
            <span className="flex items-center gap-2 tabular-nums text-white/70">
              <span>{Number(formatUnits(wethOwed, 18)).toFixed(5)} WETH</span>
              <span>{Number(formatUnits(ethOwed, 18)).toFixed(5)} ETH</span>
            </span>
          </div>
        );
      })}
      <div className="flex gap-2">
        {weth && (
          <button
            className="btn flex-1"
            disabled={busy}
            onClick={() =>
              release.writeContract({
                address: splitter,
                abi: creatorSplitterAbi,
                functionName: "releaseAll",
                args: [weth],
                chainId: CHAIN_ID,
              })
            }
          >
            Release WETH to all
          </button>
        )}
        <button
          className="btn flex-1"
          disabled={busy}
          onClick={() =>
            release.writeContract({
              address: splitter,
              abi: creatorSplitterAbi,
              functionName: "releaseAll",
              args: [zeroAddress],
              chainId: CHAIN_ID,
            })
          }
        >
          Release ETH to all
        </button>
      </div>
    </div>
  );
}
