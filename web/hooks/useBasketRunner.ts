"use client";

import { useCallback, useState } from "react";
import { useWriteContract, usePublicClient, useAccount, useSendCalls, useWalletClient } from "wagmi";
import { waitForCallsStatus } from "viem/actions";
import type { Address } from "viem";
import { erc20Abi, projectTreasuryWriteAbi } from "@/lib/abis";
import { basketZapAbi } from "@/lib/basketZapAbi";
import { BASKET_ZAP_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import { buildBasketCalls } from "@/lib/eip5792";
import type { StepStatus, LaunchStep } from "@/hooks/useLaunchRunner";

const CHAIN_ID = activeChain.id;
const MAX_UINT256 = 2n ** 256n - 1n;

export type BasketLeg = {
  asset: Address;
  symbol?: string;
  weightBps: number;
  // V4Router rewrite (docs/DECISIONS.md §6): routes are selected by index into
  // BasketZap's fixed Fables/Ramses tables (web/lib/routerV2.ts), with
  // `preferFables` chosen off-chain from a live dual-venue quote.
  preferFables: boolean;
  fablesHopIdx: bigint[];
  ramsesHopIdx: bigint[];
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

  // One step: optional precheck (skip as already-done), write, poll receipt.
  // Shared by the full run() and the deposit-only runDeposits() resume flow.
  const sendStep = useCallback(
    async (key: string, write: () => Promise<`0x${string}`>, precheck?: () => Promise<boolean>) => {
      if (!publicClient) throw { __handled: true, key, msg: "No RPC client" } as HandledError;
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
    },
    [publicClient, patch],
  );

  // approve (MAX, skipped when allowance already covers) + deposit of the
  // creator's full live balance of `asset` into the treasury.
  const approveAndDeposit = useCallback(
    async (treasury: Address, asset: Address, amount: bigint) => {
      if (!publicClient || !account) return;
      await sendStep(
        `approve_${asset}`,
        () =>
          // Approve MAX, not the exact amount: "approve once for future
          // baskets." The precheck below then skips this step on every
          // later basket for the same asset (allowance already covers it).
          writeContractAsync({
            address: asset,
            abi: erc20Abi,
            functionName: "approve",
            args: [treasury, MAX_UINT256],
            chainId: CHAIN_ID,
          }),
        async () => {
          const allowance = (await publicClient.readContract({
            address: asset,
            abi: erc20Abi,
            functionName: "allowance",
            args: [account, treasury],
          })) as bigint;
          return allowance >= amount;
        },
      );
      await sendStep(`deposit_${asset}`, () =>
        writeContractAsync({
          address: treasury,
          abi: projectTreasuryWriteAbi,
          functionName: "deposit",
          args: [asset, amount],
          chainId: CHAIN_ID,
        }),
      );
    },
    [publicClient, account, sendStep, writeContractAsync],
  );

  const handleRunError = useCallback(
    (err: unknown) => {
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
    },
    [patch],
  );

  const run = useCallback(
    async (params: BasketRunParams) => {
      if (!BASKET_ZAP_ADDRESS || !publicClient || !account) return;
      const zapAddress = BASKET_ZAP_ADDRESS;
      setSteps(baseSteps(params.legs));
      setDone(false);
      setIsRunning(true);

      const send = sendStep;

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
                preferFables: l.preferFables,
                fablesHopIdx: l.fablesHopIdx,
                ramsesHopIdx: l.ramsesHopIdx,
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
          await approveAndDeposit(params.treasury, leg.asset, amount);
        }

        setDone(true);
      } catch (err: unknown) {
        handleRunError(err);
      } finally {
        setIsRunning(false);
      }
    },
    [publicClient, writeContractAsync, account, sendStep, approveAndDeposit, handleRunError],
  );

  // Resume flow: deposit-only, for assets already swapped into the creator's
  // wallet by a basket run that stopped before depositing (step flow abandoned
  // halfway, or a batched run's better-than-minOut surplus). No swap step.
  const runDeposits = useCallback(
    async (treasury: Address, assets: { asset: Address; symbol?: string }[]) => {
      if (!publicClient || !account) return;
      const steps: LaunchStep[] = [];
      for (const a of assets) {
        const label = a.symbol ?? a.asset.slice(0, 8);
        steps.push({ key: `approve_${a.asset}`, label: `Approve treasury to pull ${label}`, status: "idle" });
        steps.push({ key: `deposit_${a.asset}`, label: `Deposit ${label} into treasury`, status: "idle" });
      }
      setSteps(steps);
      setDone(false);
      setIsRunning(true);
      try {
        for (const a of assets) {
          const amount = (await publicClient.readContract({
            address: a.asset,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
          })) as bigint;
          if (amount === 0n) {
            patch(`approve_${a.asset}`, { status: "success" });
            patch(`deposit_${a.asset}`, { status: "success" });
            continue;
          }
          await approveAndDeposit(treasury, a.asset, amount);
        }
        setDone(true);
      } catch (err: unknown) {
        handleRunError(err);
      } finally {
        setIsRunning(false);
      }
    },
    [publicClient, account, approveAndDeposit, handleRunError, patch],
  );

  // EIP-5792 one-shot: swap + every approve + every deposit in a SINGLE atomic
  // batch (one confirmation, all-or-nothing). Only usable when the wallet
  // reports atomic-batch support (BasketPicker checks and routes here). Deposits
  // each leg's minOut — the pre-encoded calls can't read the swap's actual
  // output — so a better-than-quoted swap leaves a small surplus in the wallet,
  // recoverable via the Resume-deposit banner. See lib/eip5792.ts.
  const { sendCallsAsync } = useSendCalls();
  // wallet_getCallsStatus is a WALLET method — poll it on the wallet client
  // (the injected provider), never the public RPC client (the node doesn't
  // implement it).
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID });
  const runBatched = useCallback(
    async (params: BasketRunParams) => {
      if (!BASKET_ZAP_ADDRESS || !publicClient || !account || !walletClient) return;
      setSteps([{ key: "batch", label: `Confirm basket — 1 signature (${params.legs.length} asset${params.legs.length === 1 ? "" : "s"})`, status: "idle" }]);
      setDone(false);
      setIsRunning(true);
      try {
        patch("batch", { status: "pending", error: undefined });
        const calls = buildBasketCalls({
          basketZap: BASKET_ZAP_ADDRESS,
          launchToken: params.launchToken,
          treasury: params.treasury,
          ethIn: params.ethIn,
          legs: params.legs,
          deadline: params.deadline,
        });
        const { id } = await sendCallsAsync({ calls, forceAtomic: true });
        patch("batch", { status: "confirming" });
        const res = await waitForCallsStatus(walletClient, { id });
        if (res.status !== "success") {
          throw new Error(`Batch did not succeed (status: ${res.status})`);
        }
        patch("batch", { status: "success" });
        setDone(true);
      } catch (err: unknown) {
        patch("batch", { status: "error", error: decodeTxError(err) });
      } finally {
        setIsRunning(false);
      }
    },
    [publicClient, account, walletClient, sendCallsAsync, patch],
  );

  const reset = useCallback(() => {
    setSteps([]);
    setDone(false);
  }, []);

  return { steps, run, runBatched, runDeposits, reset, isRunning, done };
}
