"use client";

import { useMemo } from "react";
import { formatUnits, erc20Abi, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { useAssets } from "@/hooks/useAssets";
import { useBasketRunner } from "@/hooks/useBasketRunner";
import { useInvalidateChainReads } from "@/hooks/useInvalidateChainReads";
import { BasketProgress } from "@/components/app/basket/BasketPicker";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;

/// "Resume deposit" — shown to the creator on the backing page when a past
/// basket swap left assets in their wallet that never made it into the
/// treasury (the step flow was abandoned after the swap, or a batched run's
/// better-than-minOut surplus). Scope is deliberately narrow: ONLY assets a
/// BasketSwapped event for THIS launch actually swapped (passed in by
/// BasketSection from useBasketHistory) — never arbitrary wallet holdings.
/// A balance below the asset's registry minDeposit is ignored (depositing it
/// would revert BelowMinimum).
export function ResumeDepositBanner({
  treasury,
  swappedAssets,
}: {
  treasury: Address;
  swappedAssets: Address[];
}) {
  const { address: account } = useAccount();
  const { assets: registryAssets } = useAssets();
  const runner = useBasketRunner();
  const invalidateChainReads = useInvalidateChainReads();

  const unique = useMemo(
    () => Array.from(new Set(swappedAssets.map((a) => a.toLowerCase()))) as Address[],
    [swappedAssets],
  );

  const balanceReads = useReadContracts({
    allowFailure: true,
    contracts:
      account && unique.length > 0
        ? unique.map((asset) => ({
            address: asset,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [account] as const,
            chainId: CHAIN_ID,
          }))
        : [],
    query: { enabled: Boolean(account) && unique.length > 0 },
  });

  const pending = useMemo(() => {
    if (!account) return [];
    return unique
      .map((asset, i) => {
        const r = balanceReads.data?.[i];
        const balance = r?.status === "success" ? (r.result as bigint) : 0n;
        const reg = registryAssets.find((a) => a.address.toLowerCase() === asset.toLowerCase());
        const floor = reg && reg.minDeposit > 0n ? reg.minDeposit : 1n;
        return { asset, symbol: reg?.symbol, balance, ok: balance >= floor };
      })
      .filter((p) => p.ok);
  }, [account, unique, balanceReads.data, registryAssets]);

  if (!account || pending.length === 0) {
    // Still show the progress/result if a resume run is underway even after
    // the pending list empties (balances drop as deposits land).
    if (runner.steps.length === 0) return null;
  }

  if (runner.steps.length > 0) {
    return (
      <div className="rounded-input border border-border p-4">
        <BasketProgress
          steps={runner.steps}
          isRunning={runner.isRunning}
          done={runner.done}
          onDone={() => {
            runner.reset();
            invalidateChainReads();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-input border border-warning/40 bg-warning/5 px-3 py-2">
      <p className="text-xs text-text-muted">
        {pending.length} swapped asset{pending.length === 1 ? "" : "s"} from a basket{" "}
        {pending.length === 1 ? "is" : "are"} still in your wallet, not the treasury
        {" — "}
        {pending
          .map((p) => `${formatUnits(p.balance, 18)} ${p.symbol ?? p.asset.slice(0, 8)}`)
          .join(", ")}
        .
      </p>
      <button
        type="button"
        className="btn-secondary shrink-0"
        onClick={() => void runner.runDeposits(treasury, pending.map((p) => ({ asset: p.asset, symbol: p.symbol })))}
      >
        Resume deposit
      </button>
    </div>
  );
}
