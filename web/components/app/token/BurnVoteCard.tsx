"use client";

import { useMemo, useState } from "react";
import { type Address, parseUnits, maxUint256 } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { burnVoteAbi, erc20Abi } from "@/lib/abis";
import { BURN_VOTE_ADDRESS, isBurnVoteConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { useAssets } from "@/hooks/useAssets";
import { useNow } from "@/hooks/useNow";
import { formatDuration } from "@/lib/format";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TokenAmount } from "@/components/app/TokenAmount";

const CHAIN_ID = activeChain.id;

/** Burn-to-vote card: this week's tallies, time left, the current default, and a
 *  vote form. A vote burns the voter's tokens to the dead address and signals the
 *  community's default round-up stock. The vote controls no funds. Hidden unless
 *  NEXT_PUBLIC_BURN_VOTE is set. */
export function BurnVoteCard({ token }: { token: Address }) {
  const { address: account } = useAccount();
  const { assets } = useAssets();
  const now = useNow(15_000);

  const bv = BURN_VOTE_ADDRESS;
  const base = { address: bv, abi: burnVoteAbi, chainId: CHAIN_ID } as const;

  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { ...base, functionName: "defaultStock", args: [token] },
      { ...base, functionName: "currentLeader", args: [token] },
      { ...base, functionName: "timeLeftInEpoch" },
      { ...base, functionName: "currentEpoch" },
    ],
    query: { enabled: isBurnVoteConfigured },
  });

  const defaultStock = reads.data?.[0]?.result as Address | undefined;
  const leader = reads.data?.[1]?.result as readonly [Address, bigint] | undefined;
  const timeLeftRaw = reads.data?.[2]?.result as bigint | undefined;
  const epoch = reads.data?.[3]?.result as bigint | undefined;

  const tallies = useReadContract({
    ...base,
    functionName: "epochTallies",
    args: epoch !== undefined ? [token, epoch] : undefined,
    query: { enabled: isBurnVoteConfigured && epoch !== undefined },
  });
  const [tallyStocks, tallyVotes] =
    (tallies.data as readonly [readonly Address[], readonly bigint[]] | undefined) ?? [[], []];

  const symbolOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assets) if (a.symbol) m.set(a.address.toLowerCase(), a.symbol);
    return (a?: Address) => (a ? m.get(a.toLowerCase()) ?? shortAddress(a) : undefined);
  }, [assets]);

  // Time left: the on-chain value is a point-in-time read; decay it locally so
  // the countdown stays live without re-reading every second.
  const [readAt] = useState(() => Math.floor(Date.now() / 1000));
  const timeLeft =
    timeLeftRaw !== undefined
      ? Math.max(0, Number(timeLeftRaw) - (now > 0 ? now - readAt : 0))
      : undefined;

  // ── vote form ──
  const [stock, setStock] = useState<Address | "">("");
  const [amount, setAmount] = useState("");

  const decimals = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
    chainId: CHAIN_ID,
  });
  const dec = (decimals.data as number | undefined) ?? 18;

  const allowance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: account && bv ? [account, bv] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(account && bv) },
  });

  let amountWei: bigint | undefined;
  try {
    amountWei = amount ? parseUnits(amount, dec) : undefined;
  } catch {
    amountWei = undefined;
  }
  const needsApproval =
    amountWei !== undefined &&
    allowance.data !== undefined &&
    (allowance.data as bigint) < amountWei;

  const approve = useWriteContract();
  const vote = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const voteReceipt = useWaitForTransactionReceipt({ hash: vote.data });

  const busy =
    approve.isPending || vote.isPending || approveReceipt.isLoading || voteReceipt.isLoading;
  const canVote = Boolean(account && bv && stock && amountWei && amountWei > 0n && !busy);

  if (!isBurnVoteConfigured || !bv) return null;

  // routable/registry stocks a token can be backed by; self-votes excluded.
  const options = assets.filter((a) => a.address.toLowerCase() !== token.toLowerCase());

  async function onVote() {
    if (!bv || !stock || !amountWei) return;
    if (needsApproval) {
      await approve.writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [bv, maxUint256],
        chainId: CHAIN_ID,
      });
    }
    await vote.writeContractAsync({
      address: bv,
      abi: burnVoteAbi,
      functionName: "vote",
      args: [token, stock as Address, amountWei],
      chainId: CHAIN_ID,
    });
    setAmount("");
  }

  const voted = voteReceipt.isSuccess;

  return (
    <div className="card space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="section-label">Burn-to-vote</div>
        <div className="text-xs text-white/50">
          {timeLeft !== undefined ? `${formatDuration(timeLeft)} left this week` : "—"}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="eyebrow">Current default</div>
          <div className="mt-1 font-medium">
            {defaultStock && defaultStock !== "0x0000000000000000000000000000000000000000"
              ? symbolOf(defaultStock)
              : "None (SGOV suggested)"}
          </div>
        </div>
        <div>
          <div className="eyebrow">Leading this week</div>
          <div className="mt-1 font-medium">
            {leader && leader[0] !== "0x0000000000000000000000000000000000000000"
              ? symbolOf(leader[0])
              : "No clear lead"}
          </div>
        </div>
      </div>

      {tallyStocks.length > 0 && (
        <div className="space-y-1">
          <div className="eyebrow">This week</div>
          <ul className="space-y-1 text-sm">
            {tallyStocks.map((s, i) => (
              <li key={s} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{symbolOf(s)}</span>
                <TokenAmount value={tallyVotes[i] ?? 0n} decimals={dec} className="text-white/70" />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <select
          className="input w-full"
          value={stock}
          onChange={(e) => setStock(e.target.value as Address)}
          disabled={busy}
        >
          <option value="">Choose a stock…</option>
          {options.map((a) => (
            <option key={a.address} value={a.address}>
              {a.symbol ?? shortAddress(a.address)}
            </option>
          ))}
        </select>
        <input
          className="input w-full"
          inputMode="decimal"
          placeholder="Amount to burn"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
        />
        <button className={cn("btn btn-primary w-full")} onClick={onVote} disabled={!canVote}>
          {busy ? "Confirming…" : needsApproval ? "Approve & vote" : "Burn to vote"}
        </button>
      </div>

      <p className="note">
        Voting sends your tokens to the dead address — they are burned and cannot be recovered.
        This is a signal for the community&apos;s default round-up stock only; it controls no
        funds. Holding a token gives no claim, redemption right, or entitlement to treasury
        assets.
      </p>
      {voted && <p className="text-xs text-[#00C805]">Vote recorded.</p>}
    </div>
  );
}
