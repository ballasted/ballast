"use client";

import { useCallback, useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { decodeEventLog, type Address } from "viem";
import { ballastFactoryAbi, erc20Abi, projectTreasuryWriteAbi } from "@/lib/abis";
import { FACTORY_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";

const CHAIN_ID = activeChain.id;

export type StepStatus = "idle" | "pending" | "confirming" | "success" | "error";
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

export function useLaunchRunner() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const [steps, setSteps] = useState<LaunchStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ token: Address; treasury: Address } | null>(null);

  const patch = useCallback((key: string, p: Partial<LaunchStep>) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...p } : s)));
  }, []);

  const run = useCallback(
    async (params: LaunchParams) => {
      if (!FACTORY_ADDRESS || !publicClient) return;
      const factory = FACTORY_ADDRESS; // narrowed for closures below
      const backed = Boolean(params.deposit);
      setSteps(baseSteps(backed));
      setResult(null);
      setIsRunning(true);

      // Each phase: send tx (pending) -> wait receipt (confirming) -> success.
      const send = async (
        key: string,
        write: () => Promise<`0x${string}`>,
      ): Promise<`0x${string}`> => {
        patch(key, { status: "pending", error: undefined });
        const hash = await write();
        patch(key, { status: "confirming", txHash: hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Transaction reverted on-chain");
        patch(key, { status: "success" });
        return hash;
      };

      try {
        // 1. launch -> decode Launched to get token + treasury.
        const launchHash = await send("launch", () =>
          writeContractAsync({
            address: factory,
            abi: ballastFactoryAbi,
            functionName: "launch",
            args: [params.name, params.symbol, params.noticePeriod, params.metadataURI],
            chainId: CHAIN_ID,
          }),
        );
        const receipt = await publicClient.getTransactionReceipt({ hash: launchHash });
        let token: Address | undefined;
        let treasury: Address | undefined;
        for (const log of receipt.logs) {
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

        // 2 + 3. Backed: approve the treasury to pull the asset, then deposit.
        if (params.deposit) {
          const { asset, amount } = params.deposit;
          await send("approve", () =>
            writeContractAsync({
              address: asset,
              abi: erc20Abi,
              functionName: "approve",
              args: [treasury!, amount],
              chainId: CHAIN_ID,
            }),
          );
          await send("deposit", () =>
            writeContractAsync({
              address: treasury!,
              abi: projectTreasuryWriteAbi,
              functionName: "deposit",
              args: [asset, amount],
              chainId: CHAIN_ID,
            }),
          );
        }

        // 4. graduate -> derives P0 from backing (or constant if unbacked) and
        //    seeds the one-sided pool, locking LP permanently.
        await send("graduate", () =>
          writeContractAsync({
            address: factory,
            abi: ballastFactoryAbi,
            functionName: "graduate",
            args: [token],
            chainId: CHAIN_ID,
          }),
        );

        setResult({ token, treasury });
      } catch (err: unknown) {
        const msg = decodeTxError(err);
        setSteps((prev) => {
          const active = prev.find((s) => s.status === "pending" || s.status === "confirming");
          return active
            ? prev.map((s) => (s.key === active.key ? { ...s, status: "error", error: msg } : s))
            : prev;
        });
      } finally {
        setIsRunning(false);
      }
    },
    [publicClient, writeContractAsync, patch],
  );

  return { steps, run, isRunning, result };
}
