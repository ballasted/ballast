"use client";

import { useCallback, useState } from "react";
import { useWriteContract, usePublicClient, useAccount } from "wagmi";
import type { Address } from "viem";
import { erc20Abi, projectTreasuryWriteAbi } from "@/lib/abis";
import { basketZapAbi } from "@/lib/basketZapAbi";
import { BASKET_ZAP_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import type { StepStatus, LaunchStep } from "@/hooks/useLaunchRunner";

const CHAIN_ID = activeChain.id;

export type BasketLeg = {
  asset: Address;
  symbol?: string;
  weightBps: number;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  minOut: bigint;
};

export type BasketRunParams = {
  launchToken: Address;
  treasury: Address;
  ethIn: bigint;
  legs: BasketLeg[];
  deadline: bigint;
};

// One "swap" step (BasketZap.swapBasket, a single signature covering every
// leg), then an unavoidable approve + deposit pair PER ASSET directly against
// the creator's own treasury — BasketZap can never make that call for them
// (docs/DECISIONS.md §1). The step list says so explicitly rather than
// implying the whole basket lands in one signature.
function baseSteps(legs: BasketLeg[]): LaunchStep[] {
  const steps: LaunchStep[] = [{ key: "swap", label: `Swap ETH into ${legs.length} asset${legs.length === 1 ? "" : "s"}`, status: "idle" }];
  for (const leg of legs) {
    const label = leg.symbol ?? leg.asset.slice(0, 8);
    steps.push({ key: `approve_${leg.asset}`, label: `Approve treasury to pull ${label}`, status: "idle" });
    steps.push({ key: `deposit_${leg.asset}`, label: `Deposit ${label} into treasury`, status: "idle" });
  }
  return steps;
}

type LostSignal = { __lost: true; key: string };
type HandledError = { __handled: true; key: string; msg: string };
function isLost(e: unknown): e is LostSignal {
  return Boolean(e && typeof e === "object" && "__lost" in e);
}
function isHandled(e: unknown): e is HandledError {
  return Boolean(e && typeof e === "object" && "__handled" in e);
}

export function useBasketRunner() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { address: account } = useAccount();

  const [steps, setSteps] = useState<LaunchStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [done, setDone] = useState(false);

  const patch = useCallback((key: string, p: Partial<{ status: StepStatus; txHash?: `0x${string}`; error?: string }>) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...p } : s)));
  }, []);

  const run = useCallback(
    async (params: BasketRunParams) => {
      if (!BASKET_ZAP_ADDRESS || !publicClient || !account) return;
      const zapAddress = BASKET_ZAP_ADDRESS;
      setSteps(baseSteps(params.legs));
      setDone(false);
      setIsRunning(true);

      const send = async (
        key: string,
        write: () => Promise<`0x${string}`>,
        precheck?: () => Promise<boolean>,
      ) => {
        if (precheck) {
          try {
            if (await precheck()) {
              patch(key, { status: "success" });
              return;
            }
          } catch {
            /* precheck read failed — fall through and attempt the write */
          }
        }
        patch(key, { status: "pending", error: undefined });
        let hash: `0x${string}`;
        try {
          hash = await write();
        } catch (e) {
          throw { __handled: true, key, msg: decodeTxError(e) } as HandledError;
        }
        patch(key, { status: "confirming", txHash: hash });
        const outcome = await pollReceipt(publicClient, hash);
        if (outcome.status === "lost") throw { __lost: true, key } as LostSignal;
        if (outcome.status === "reverted") {
          throw { __handled: true, key, msg: "Transaction reverted on-chain" } as HandledError;
        }
        patch(key, { status: "success" });
      };

      try {
        // 1. swap — no precheck: a partial-basket retry is rare enough (and
        //    re-swapping is harmless, just extra gas + a fresh set of tokens
        //    the creator already has approve/deposit steps to absorb) that
        //    idempotency isn't worth the complexity here.
        await send("swap", () =>
          writeContractAsync({
            address: zapAddress,
            abi: basketZapAbi,
            functionName: "swapBasket",
            args: [
              params.launchToken,
              params.legs.map((l) => ({
                asset: l.asset,
                weightBps: l.weightBps,
                fee: l.fee,
                tickSpacing: l.tickSpacing,
                hooks: l.hooks,
                minOut: l.minOut,
              })),
              params.deadline,
            ],
            value: params.ethIn,
            chainId: CHAIN_ID,
          }),
        );

        // 2. approve + deposit, per leg — unavoidably creator-direct.
        for (const leg of params.legs) {
          // The amount actually received is whatever the swap paid out, which
          // can only legitimately exceed minOut — read the creator's live
          // balance rather than re-deriving an expected amount.
          const amount = (await publicClient.readContract({
            address: leg.asset,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
          })) as bigint;
          if (amount === 0n) continue;

          await send(
            `approve_${leg.asset}`,
            () =>
              writeContractAsync({
                address: leg.asset,
                abi: erc20Abi,
                functionName: "approve",
                args: [params.treasury, amount],
                chainId: CHAIN_ID,
              }),
            async () => {
              const allowance = (await publicClient.readContract({
                address: leg.asset,
                abi: erc20Abi,
                functionName: "allowance",
                args: [account, params.treasury],
              })) as bigint;
              return allowance >= amount;
            },
          );
          await send(
            `deposit_${leg.asset}`,
            () =>
              writeContractAsync({
                address: params.treasury,
                abi: projectTreasuryWriteAbi,
                functionName: "deposit",
                args: [leg.asset, amount],
                chainId: CHAIN_ID,
              }),
          );
        }

        setDone(true);
      } catch (err: unknown) {
        if (isLost(err)) {
          patch(err.key, { status: "lost" });
        } else if (isHandled(err)) {
          patch(err.key, { status: "error", error: err.msg });
        } else {
          const msg = decodeTxError(err);
          setSteps((prev) => {
            const active = prev.find((s) => s.status === "pending" || s.status === "confirming");
            return active ? prev.map((s) => (s.key === active.key ? { ...s, status: "error", error: msg } : s)) : prev;
          });
        }
      } finally {
        setIsRunning(false);
      }
    },
    [publicClient, writeContractAsync, patch, account],
  );

  const reset = useCallback(() => {
    setSteps([]);
    setDone(false);
  }, []);

  return { steps, run, reset, isRunning, done };
}
