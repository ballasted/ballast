"use client";

import { useMemo, useState } from "react";
import { type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { projectTreasuryAbi, erc20Abi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useRouterCreator } from "@/hooks/useRouterCreator";
import { formatDuration, shortAddress } from "@/lib/format";
import { formatEt } from "@/lib/marketHours";
import { ConnectButton } from "@/components/app/ConnectButton";
import { TokenAmount } from "@/components/app/TokenAmount";

const CHAIN_ID = activeChain.id;
const PENDING = 1; // PendingStatus.Pending
const MAX_READ = 100; // bound reads to the most recent N proposals

type Phase = "idle" | "pending" | "confirming" | "lost" | "error" | "done";

type PendingProposal = {
  id: bigint;
  depositor: Address;
  asset: Address;
  amount: bigint;
  proposedAt: number;
  acceptEnds: number;
};

/**
 * Pending third-party deposit proposals on a treasury (e.g. a Creator Fund prize
 * proposed by the Safe). Anyone sees that a deposit is awaiting the creator's
 * acceptance (public disclosure); only the connected CREATOR gets Accept / Decline.
 * Accepting locks the funds permanently (ProjectTreasury.acceptDeposit → lockedBalance;
 * never withdrawable). Reverts after the 7-day ACCEPT_WINDOW, after which anyone may
 * reclaim the funds back to the depositor. Renders nothing when there are no pending
 * proposals.
 */
export function PendingDepositsCard({
  token,
  treasury,
  creator,
  symbol,
  now,
}: {
  token?: Address;
  treasury?: Address;
  creator?: Address;
  symbol?: string;
  now: number;
}) {
  const { address: account, isConnected } = useAccount();
  const { isRouterManaged, router, effectiveCreator } = useRouterCreator(token, creator);
  const isCreator = Boolean(account && effectiveCreator && account.toLowerCase() === effectiveCreator.toLowerCase());
  const writeTarget = isRouterManaged && router ? router : treasury;

  const countRes = useReadContract({
    address: treasury,
    abi: projectTreasuryAbi,
    functionName: "pendingCount",
    chainId: CHAIN_ID,
    query: { enabled: Boolean(treasury), refetchInterval: 30_000 },
  });
  const windowRes = useReadContract({
    address: treasury,
    abi: projectTreasuryAbi,
    functionName: "ACCEPT_WINDOW",
    chainId: CHAIN_ID,
    query: { enabled: Boolean(treasury) },
  });

  const count = countRes.data ? Number(countRes.data) : 0;
  const acceptWindow = windowRes.data ? Number(windowRes.data) : 7 * 24 * 60 * 60;

  // Ids are 1-based; read the most recent MAX_READ.
  const ids = useMemo(() => {
    const start = Math.max(1, count - MAX_READ + 1);
    const out: bigint[] = [];
    for (let i = start; i <= count; i++) out.push(BigInt(i));
    return out;
  }, [count]);

  const depositsRes = useReadContracts({
    allowFailure: true,
    contracts: ids.map(
      (id) => ({ address: treasury, abi: projectTreasuryAbi, functionName: "pendingDeposits", args: [id], chainId: CHAIN_ID }) as const,
    ),
    query: { enabled: ids.length > 0, refetchInterval: 30_000 },
  });

  const proposals = useMemo<PendingProposal[]>(() => {
    const rows = depositsRes.data ?? [];
    const out: PendingProposal[] = [];
    rows.forEach((r, i) => {
      if (r.status !== "success") return;
      const [depositor, asset, amount, proposedAt, status] = r.result as readonly [
        Address,
        Address,
        bigint,
        bigint,
        number,
        `0x${string}`,
      ];
      if (Number(status) !== PENDING) return;
      const pa = Number(proposedAt);
      out.push({ id: ids[i]!, depositor, asset, amount, proposedAt: pa, acceptEnds: pa + acceptWindow });
    });
    return out;
  }, [depositsRes.data, ids, acceptWindow]);

  // Symbols + decimals for the distinct pending assets.
  const assets = useMemo(() => Array.from(new Set(proposals.map((p) => p.asset.toLowerCase()))) as Address[], [proposals]);
  const metaRes = useReadContracts({
    allowFailure: true,
    contracts: assets.flatMap(
      (a) =>
        [
          { address: a, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID },
          { address: a, abi: erc20Abi, functionName: "decimals", chainId: CHAIN_ID },
        ] as const,
    ),
    query: { enabled: assets.length > 0 },
  });
  const assetMeta = useMemo(() => {
    const m = new Map<string, { symbol: string; decimals: number }>();
    assets.forEach((a, i) => {
      const sym = metaRes.data?.[i * 2]?.status === "success" ? (metaRes.data[i * 2]!.result as string) : "asset";
      const dec = metaRes.data?.[i * 2 + 1]?.status === "success" ? (metaRes.data[i * 2 + 1]!.result as number) : 18;
      m.set(a.toLowerCase(), { symbol: sym, decimals: dec });
    });
    return m;
  }, [assets, metaRes.data]);

  if (!treasury || proposals.length === 0) return null;

  return (
    <section className="card border-accent p-5">
      <h2 className="section-label">Pending treasury deposits</h2>
      <p className="mt-2 text-sm text-text-muted">
        {isCreator
          ? "Accept to lock these into the treasury permanently, or decline to return them. Expires 7 days after the proposal."
          : `A deposit is awaiting ${symbol ? `$${symbol}'s` : "the"} creator's acceptance. Only the creator can accept it.`}
      </p>
      <ul className="mt-3 space-y-3">
        {proposals.map((p) => (
          <ProposalRow
            key={p.id.toString()}
            proposal={p}
            meta={assetMeta.get(p.asset.toLowerCase()) ?? { symbol: "asset", decimals: 18 }}
            now={now}
            isCreator={isCreator}
            isConnected={isConnected}
            writeTarget={writeTarget}
          />
        ))}
      </ul>
    </section>
  );
}

function ProposalRow({
  proposal,
  meta,
  now,
  isCreator,
  isConnected,
  writeTarget,
}: {
  proposal: PendingProposal;
  meta: { symbol: string; decimals: number };
  now: number;
  isCreator: boolean;
  isConnected: boolean;
  writeTarget?: Address;
}) {
  const { wrongNetwork, switchToRobinhood, isSwitching } = useNetworkGuard();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>("idle");
  const [hash, setHash] = useState<`0x${string}`>();
  const [err, setErr] = useState<string>();
  const explorer = activeChain.blockExplorers.default.url;

  const remaining = now > 0 ? proposal.acceptEnds - now : 0;
  const expired = now > 0 && remaining <= 0;

  async function run(fn: "acceptDeposit" | "declineDeposit") {
    if (!writeTarget) return;
    setErr(undefined);
    setPhase("pending");
    let h: `0x${string}`;
    try {
      h = await writeContractAsync({
        address: writeTarget,
        abi: projectTreasuryAbi,
        functionName: fn,
        args: [proposal.id],
        chainId: CHAIN_ID,
      });
    } catch (e) {
      setErr(decodeTxError(e));
      setPhase("error");
      return;
    }
    setHash(h);
    setPhase("confirming");
    if (!publicClient) return;
    const outcome = await pollReceipt(publicClient, h);
    if (outcome.status === "lost") return setPhase("lost");
    if (outcome.status === "reverted") {
      setErr("Transaction reverted on-chain.");
      return setPhase("error");
    }
    setPhase("done");
  }

  if (phase === "done") {
    return (
      <li className="note note-positive p-3">
        <span className="font-semibold text-green">Done ✓</span>{" "}
        <button className="ml-2 underline" onClick={() => window.location.reload()}>
          Reload
        </button>
      </li>
    );
  }

  const busy = phase === "pending" || phase === "confirming";

  return (
    <li className="rounded-input bg-bg p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-text-primary">
          <TokenAmount value={proposal.amount} decimals={meta.decimals} symbol={meta.symbol} />
        </span>
        <span className="text-xs text-text-faint">from {shortAddress(proposal.depositor)}</span>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        {expired ? (
          <span className="text-warning">Acceptance window closed — the depositor can reclaim it.</span>
        ) : (
          <>
            Accept within <span className="text-text-secondary">{formatDuration(remaining)}</span> (by {formatEt(proposal.acceptEnds)}).
          </>
        )}
      </p>

      {isCreator ? (
        !isConnected ? (
          <div className="mt-3">
            <ConnectButton />
          </div>
        ) : wrongNetwork ? (
          <button className="btn-primary mt-3 w-full" onClick={() => void switchToRobinhood()} disabled={isSwitching}>
            {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
          </button>
        ) : (
          <div className="mt-3 flex gap-2">
            <button className="btn-primary flex-1" onClick={() => run("acceptDeposit")} disabled={expired || busy}>
              {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Waiting…" : "Accept"}
            </button>
            <button className="btn-secondary flex-1" onClick={() => run("declineDeposit")} disabled={busy}>
              Decline
            </button>
          </div>
        )
      ) : null}

      {phase === "lost" && hash && (
        <p className="mt-2 text-xs text-warning">
          Lost track of this transaction — check{" "}
          <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="underline">
            Blockscout
          </a>{" "}
          before retrying.
        </p>
      )}
      {err && <p className="mt-2 text-xs text-negative">{err}</p>}
    </li>
  );
}
