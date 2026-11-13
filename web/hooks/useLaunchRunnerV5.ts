"use client";

import { useCallback, useRef, useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { decodeEventLog, type Address } from "viem";
import { ballastFactoryV5Abi } from "@/lib/abisV5";
import { FACTORY_ADDRESS, WETH_ADDRESS } from "@/lib/contracts";
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

// A gen-5 (Elysium) launch is SIMPLER than gen-4: no treasury, no deposit, no notice
// period. The pool is always WHYPE and the LP is locked forever at graduation. The
// creator picks a fixed-forever swap fee (1–10%) and the FeeRouterV5 split (creator /
// buyback / rewards, summing to 100%).
export type LaunchParamsV5 = {
  name: string;
  symbol: string;
  metadataURI: string; // ipfs://CID of pinned metadata JSON (pinned before run)
  swapFeeBps: number; // creator-picked swap fee, 100–1000 (1%–10%). Fixed forever.
  quoteAsset: Address; // WHYPE (the only green quote asset on Elysium)
  // FeeRouterV5 launch split, must sum to 10000.
  creatorBps: number;
  buybackBps: number;
  rewardsBps: number;
};

const STEPS: LaunchStep[] = [
  { key: "launch", label: "Deploy token + fee router", status: "idle" },
  { key: "graduate", label: "Seed the WHYPE pool (liquidity locked forever)", status: "idle" },
];

type LostSignal = { __lost: true; key: string };
type HandledError = { __handled: true; key: string; msg: string };
function isLost(e: unknown): e is LostSignal {
  return Boolean(e && typeof e === "object" && "__lost" in e);
}
function isHandled(e: unknown): e is HandledError {
  return Boolean(e && typeof e === "object" && "__handled" in e);
}

export type LaunchResultV5 = { token: Address; feeRouter: Address };

export function useLaunchRunnerV5() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const [steps, setSteps] = useState<LaunchStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<LaunchResultV5 | null>(null);
  // Persisted across retries so a re-run NEVER re-deploys an already-launched token —
  // the launch step is skipped and we resume from graduate.
  const launchedRef = useRef<LaunchResultV5 | null>(null);
  const [launched, setLaunched] = useState<LaunchResultV5 | null>(null);

  const patch = useCallback((key: string, p: Partial<LaunchStep>) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...p } : s)));
  }, []);

  const run = useCallback(
    async (params: LaunchParamsV5) => {
      if (!FACTORY_ADDRESS || !publicClient) return;
      const factory = FACTORY_ADDRESS;
      setSteps(STEPS.map((s) => ({ ...s })));
      setResult(null);
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
            /* precheck read failed — attempt the write */
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
        // 1. launch (deploys FeeRouterV5 + token). Skip if a prior partial run already
        //    deployed, so Retry never double-deploys.
        let token: Address | undefined = launchedRef.current?.token;
        let feeRouter: Address | undefined = launchedRef.current?.feeRouter;
        if (token && feeRouter) {
          patch("launch", { status: "success" });
        } else {
          const quoteAsset = params.quoteAsset ?? WETH_ADDRESS;
          if (!quoteAsset) throw new Error("No quote asset (WHYPE) configured");
          const receipt = await send("launch", () =>
            writeContractAsync({
              address: factory,
              abi: ballastFactoryV5Abi,
              functionName: "launch",
              args: [
                params.name,
                params.symbol,
                params.swapFeeBps,
                params.metadataURI,
                quoteAsset,
                params.creatorBps,
                params.buybackBps,
                params.rewardsBps,
              ],
              chainId: CHAIN_ID,
            }),
          );
          for (const log of receipt!.logs) {
            try {
              const parsed = decodeEventLog({ abi: ballastFactoryV5Abi, ...log });
              if (parsed.eventName === "Launched") {
                token = parsed.args.token as Address;
                feeRouter = parsed.args.feeRouter as Address;
                break;
              }
            } catch {
              /* not our event */
            }
          }
          if (!token || !feeRouter) throw new Error("Could not read the launched token from the receipt");
          launchedRef.current = { token, feeRouter };
          setLaunched({ token, feeRouter });
        }
        const tok = token;

        // 2. graduate — seed the WHYPE pool & lock LP. Skip if already graduated.
        await send(
          "graduate",
          () =>
            writeContractAsync({
              address: factory,
              abi: ballastFactoryV5Abi,
              functionName: "graduate",
              args: [tok],
              chainId: CHAIN_ID,
            }),
          async () => {
            const g = (await publicClient.readContract({
              address: factory,
              abi: ballastFactoryV5Abi,
              functionName: "graduated",
              args: [tok],
            })) as boolean;
            return g;
          },
        );

        setResult({ token: tok, feeRouter: feeRouter! });
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
    [publicClient, writeContractAsync, patch],
  );

  const reset = useCallback(() => {
    launchedRef.current = null;
    setLaunched(null);
    setSteps([]);
    setResult(null);
  }, []);

  return { steps, run, reset, isRunning, result, launched };
}
