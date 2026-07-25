"use client";

import { useCallback, useRef, useState } from "react";
import { useWriteContract, usePublicClient, useAccount } from "wagmi";
import { decodeEventLog, type Address } from "viem";
import { ballastFactoryAbi, erc20Abi, projectTreasuryWriteAbi } from "@/lib/abis";
import { FACTORY_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";

const CHAIN_ID = activeChain.id;

export type StepStatus = "idle" | "pending" | "confirming" | "success" | "error" | "lost";
export type LaunchStep = {
  key: string;
  label: string;
  status: StepStatus;
  txHash?: `0x${string}`;
  error?: string;
};

export type LaunchParams = {
  name: string;
  symbol: string;
  noticePeriod: bigint; // seconds (7/30/90 days)
  metadataURI: string; // ipfs://CID of the pinned metadata JSON (pinned before run)
  deposit?: { asset: Address; amount: bigint }; // undefined = unbacked
};

// Steps must name exactly what executes on each path. An unbacked launch has no
// treasury deposit and graduates at a constant opening tick (BallastFactory
// UNBACKED_TICK), so it never seeds "at backing" — showing that would be a
// fabricated number. A treasury contract IS deployed on both paths, but on the
// unbacked path it is empty and never funded here, so the token step drops the
// "+ treasury" wording that only means something once assets go in.
function baseSteps(backed: boolean): LaunchStep[] {
  if (!backed) {
    return [
      { key: "launch", label: "Deploy token", status: "idle" },
      { key: "graduate", label: "Seed the pool (LP locked permanently)", status: "idle" },
    ];
  }
  return [
    { key: "launch", label: "Deploy token + treasury", status: "idle" },
    { key: "approve", label: "Approve treasury to pull the asset", status: "idle" },
    { key: "deposit", label: "Deposit into treasury", status: "idle" },
    { key: "graduate", label: "Seed the pool at backing (LP locked permanently)", status: "idle" },
  ];
}

// Thrown to stop the run without marking a step "error" — a timeout is an unknown
// outcome, not a failure.
type LostSignal = { __lost: true; key: string };
type HandledError = { __handled: true; key: string; msg: string };
function isLost(e: unknown): e is LostSignal {
  return Boolean(e && typeof e === "object" && "__lost" in e);
}
function isHandled(e: unknown): e is HandledError {
  return Boolean(e && typeof e === "object" && "__handled" in e);
}

export function useLaunchRunner() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { address: account } = useAccount();

  const [steps, setSteps] = useState<LaunchStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ token: Address; treasury: Address } | null>(null);
  // Persisted across retries so a re-run NEVER re-deploys a token that already
  // exists — the launch step is skipped and we resume from where we left off (#7).
  const launchedRef = useRef<{ token: Address; treasury: Address } | null>(null);
  const [launched, setLaunched] = useState<{ token: Address; treasury: Address } | null>(null);

  const patch = useCallback((key: string, p: Partial<LaunchStep>) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...p } : s)));
  }, []);

  const run = useCallback(
    async (params: LaunchParams) => {
      if (!FACTORY_ADDRESS || !publicClient) return;
      const factory = FACTORY_ADDRESS;
      const backed = Boolean(params.deposit);
      setSteps(baseSteps(backed));
      setResult(null);
      setIsRunning(true);

      // One phase: optionally skip if already done on-chain (precheck), else send
      // (pending) → poll receipt with backoff (confirming) → success. A read error
      // during polling is "not yet", never a failure; a wall-clock timeout is
      // "lost" (unknown), never a red X.
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
        return outcome.receipt;
      };

      try {
        // 1. launch — but skip if a prior (partial) run already deployed the token,
        //    so Retry never double-deploys.
        let token: Address | undefined = launchedRef.current?.token;
        let treasury: Address | undefined = launchedRef.current?.treasury;
        if (token && treasury) {
          patch("launch", { status: "success" });
        } else {
          const receipt = await send("launch", () =>
            writeContractAsync({
              address: factory,
              abi: ballastFactoryAbi,
              functionName: "launch",
              args: [params.name, params.symbol, params.noticePeriod, params.metadataURI],
              chainId: CHAIN_ID,
            }),
          );
          for (const log of receipt!.logs) {
            try {
              const parsed = decodeEventLog({ abi: ballastFactoryAbi, ...log });
              if (parsed.eventName === "Launched") {
                token = parsed.args.token as Address;
                treasury = parsed.args.treasury as Address;
                break;
              }
            } catch {
              /* not our event */
            }
          }
          if (!token || !treasury) throw new Error("Could not read the launched token from the receipt");
          launchedRef.current = { token, treasury };
          setLaunched({ token, treasury });
        }
        const tok = token;
        const tre = treasury;

        // 2 + 3. Backed: approve (skip if allowance already covers it), then deposit
        //         (skip if the treasury already holds the amount).
        if (params.deposit) {
          const { asset, amount } = params.deposit;
          await send(
            "approve",
            () =>
              writeContractAsync({
                address: asset,
                abi: erc20Abi,
                functionName: "approve",
                args: [tre, amount],
                chainId: CHAIN_ID,
              }),
            async () => {
              if (!account) return false;
              const allowance = (await publicClient.readContract({
                address: asset,
                abi: erc20Abi,
                functionName: "allowance",
                args: [account, tre],
              })) as bigint;
              return allowance >= amount;
            },
          );
          await send(
            "deposit",
            () =>
              writeContractAsync({
                address: tre,
                abi: projectTreasuryWriteAbi,
                functionName: "deposit",
                args: [asset, amount],
                chainId: CHAIN_ID,
              }),
            async () => {
              const held = (await publicClient.readContract({
                address: tre,
                abi: projectTreasuryWriteAbi,
                functionName: "heldBalance",
                args: [asset],
              })) as bigint;
              return held >= amount;
            },
          );
        }

        // 4. graduate — skip if the pool was already seeded (graduated), so a
        //    resume after a lost graduate tx never tries to seed twice.
        await send(
          "graduate",
          () =>
            writeContractAsync({
              address: factory,
              abi: ballastFactoryAbi,
              functionName: "graduate",
              args: [tok],
              chainId: CHAIN_ID,
            }),
          async () => {
            const g = (await publicClient.readContract({
              address: factory,
              abi: ballastFactoryAbi,
              functionName: "graduated",
              args: [tok],
            })) as boolean;
            return g;
          },
        );

        setResult({ token: tok, treasury: tre });
      } catch (err: unknown) {
        if (isLost(err)) {
          patch(err.key, { status: "lost" });
        } else if (isHandled(err)) {
          patch(err.key, { status: "error", error: err.msg });
        } else {
          // Unexpected — attach to the active step.
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
    launchedRef.current = null;
    setLaunched(null);
    setSteps([]);
    setResult(null);
  }, []);

  return { steps, run, reset, isRunning, result, launched };
}
