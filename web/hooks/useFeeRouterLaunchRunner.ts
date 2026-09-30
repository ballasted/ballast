"use client";

import { useCallback, useRef, useState } from "react";
import { useWriteContract, usePublicClient, useAccount } from "wagmi";
import { decodeEventLog, type Address } from "viem";
import { ballastFactoryAbi, erc20Abi, projectTreasuryWriteAbi, feeRouterFactoryAbi, feeRouterAbi } from "@/lib/abis";
import {
  FACTORY_ADDRESS,
  FEE_ROUTER_FACTORY_ADDRESS,
  HOOK_ADDRESS,
  WETH_ADDRESS,
  POOL_MANAGER_ADDRESS,
  ASSET_REGISTRY_ADDRESS,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import type { LaunchParams, LaunchStep, StepStatus } from "./useLaunchRunner";

const CHAIN_ID = activeChain.id;

// Fixed at 0 -- the treasury bucket's WETH/asset pool key isn't resolvable
// client-side yet (see FeesSection.tsx), so every fee-router launch today goes
// through with that bucket permanently disabled (treasuryAsset == address(0)
// forces treasuryBps == 0 in the contract's own constructor check).
const ZERO_POOL_KEY = {
  currency0: "0x0000000000000000000000000000000000000000" as Address,
  currency1: "0x0000000000000000000000000000000000000000" as Address,
  fee: 0,
  tickSpacing: 0,
  hooks: "0x0000000000000000000000000000000000000000" as Address,
};

// Same standard disclosure hash used by contracts/script/DeployFeeRouter.s.sol —
// attached to every treasury-bucket proposeDeposit (inert today, see above, but
// the router constructor requires a non-zero value regardless of whether that
// bucket is ever used).
const DISCLOSURE_VERSION = "0xf6c3b5e6a6c5d6f9a6f6a5b6c5d6e6f9a6f6a5b6c5d6e6f9a6f6a5b6c5d6e6f9" as const;

const MAX_SLIPPAGE_BPS = 1000; // 10% -- matches the create-flow's swap-tolerance norms elsewhere
const MAX_ROUTE_PER_CALL = 100_000_000_000_000_000_000n; // 100 ETH/call -- generous, never the bottleneck
const ROUTE_COOLDOWN_SECONDS = 3600n; // 1 hour between permissionless route() calls

export type FeeSplitBps = { creatorBps: number; treasuryBps: number; buybackBps: number; rewardsBps: number };

function baseSteps(backed: boolean): LaunchStep[] {
  const launch: LaunchStep = { key: "launch", label: backed ? "Deploy fee router + token + treasury" : "Deploy fee router + token", status: "idle" };
  if (!backed) {
    return [launch, { key: "graduate", label: "Seed the pool (LP locked permanently)", status: "idle" }];
  }
  return [
    launch,
    { key: "approve", label: "Approve treasury to pull the asset", status: "idle" },
    { key: "deposit", label: "Deposit into treasury", status: "idle" },
    { key: "graduate", label: "Seed the pool at backing (LP locked permanently)", status: "idle" },
  ];
}

type LostSignal = { __lost: true; key: string };
type HandledError = { __handled: true; key: string; msg: string };
function isLost(e: unknown): e is LostSignal {
  return Boolean(e && typeof e === "object" && "__lost" in e);
}
function isHandled(e: unknown): e is HandledError {
  return Boolean(e && typeof e === "object" && "__handled" in e);
}

/**
 * Same shape as useLaunchRunner, but step 1 goes through FeeRouterFactory so the
 * new router becomes the token's on-chain creator (full four-bucket routing —
 * see docs/FEE_ROUTER_DESIGN.md §2.1). Only used when the creator picks a split
 * other than 100%-to-creator in the Fees section; the default (unchanged) path
 * still calls BallastFactory.launch() directly via useLaunchRunner.
 */
export function useFeeRouterLaunchRunner() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { address: account } = useAccount();

  const [steps, setSteps] = useState<LaunchStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ token: Address; treasury: Address; router: Address } | null>(null);
  const launchedRef = useRef<{ token: Address; treasury: Address; router: Address } | null>(null);
  const [launched, setLaunched] = useState<{ token: Address; treasury: Address; router: Address } | null>(null);

  const patch = useCallback((key: string, p: Partial<LaunchStep>) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...p } : s)));
  }, []);

  const run = useCallback(
    async (params: LaunchParams, split: FeeSplitBps) => {
      if (!FACTORY_ADDRESS || !FEE_ROUTER_FACTORY_ADDRESS || !HOOK_ADDRESS || !WETH_ADDRESS || !POOL_MANAGER_ADDRESS || !ASSET_REGISTRY_ADDRESS) return;
      if (!publicClient) return;
      const backed = Boolean(params.deposit);
      setSteps(baseSteps(backed));
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
            /* fall through and attempt the write */
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
        let token: Address | undefined = launchedRef.current?.token;
        let treasury: Address | undefined = launchedRef.current?.treasury;
        let router: Address | undefined = launchedRef.current?.router;
        if (token && treasury && router) {
          patch("launch", { status: "success" });
        } else {
          const receipt = await send("launch", () =>
            writeContractAsync({
              address: FEE_ROUTER_FACTORY_ADDRESS!,
              abi: feeRouterFactoryAbi,
              functionName: "createAndLaunch",
              args: [
                HOOK_ADDRESS!,
                WETH_ADDRESS!,
                POOL_MANAGER_ADDRESS!,
                "0x0000000000000000000000000000000000000000",
                ZERO_POOL_KEY,
                ASSET_REGISTRY_ADDRESS!,
                MAX_SLIPPAGE_BPS,
                MAX_ROUTE_PER_CALL,
                ROUTE_COOLDOWN_SECONDS,
                DISCLOSURE_VERSION,
                FACTORY_ADDRESS!,
                params.name,
                params.symbol,
                params.noticePeriod,
                params.metadataURI,
                params.quoteAssets,
              ],
              chainId: CHAIN_ID,
            }),
          );
          for (const log of receipt!.logs) {
            try {
              const parsed = decodeEventLog({ abi: feeRouterFactoryAbi, ...log });
              if (parsed.eventName === "FeeRouterCreated") {
                router = parsed.args.router as Address;
              }
            } catch {
              /* not this ABI's event */
            }
            try {
              const parsed = decodeEventLog({ abi: ballastFactoryAbi, ...log });
              if (parsed.eventName === "Launched") {
                token = parsed.args.token as Address;
                treasury = parsed.args.treasury as Address;
              }
            } catch {
              /* not this ABI's event */
            }
          }
          if (!token || !treasury || !router) {
            throw new Error("Could not read the launched token/router from the receipt");
          }
          launchedRef.current = { token, treasury, router };
          setLaunched({ token, treasury, router });

          // Schedule the creator's chosen split immediately — the default
          // on-chain split is 100% creator until this lands and the 7-day
          // delay elapses, which is the correct, honest behavior (never skip
          // the delay, even for the very first split away from default).
          if (split.creatorBps !== 10000 || split.buybackBps !== 0 || split.rewardsBps !== 0 || split.treasuryBps !== 0) {
            try {
              const scheduleHash = await writeContractAsync({
                address: router,
                abi: feeRouterAbi,
                functionName: "scheduleSplit",
                args: [split.creatorBps, split.treasuryBps, split.buybackBps, split.rewardsBps],
                chainId: CHAIN_ID,
              });
              await pollReceipt(publicClient, scheduleHash);
            } catch {
              /* non-fatal — the creator can schedule it again later from the dashboard */
            }
          }
        }
        const tok = token;
        const tre = treasury;

        if (params.deposit) {
          const { asset, amount } = params.deposit;
          const rtr = router!;
          // This launch's on-chain treasury.creator is the ROUTER, not the
          // connected wallet (see docs/FEE_ROUTER_DESIGN.md §2.1) — a direct
          // treasury.deposit() call from the EOA would revert NotCreator.
          // Approve the ROUTER to pull the asset, then go through its
          // creatorDeposit passthrough, which forwards into the treasury as
          // the on-chain creator on the EOA's behalf.
          await send(
            "approve",
            () =>
              writeContractAsync({
                address: asset,
                abi: erc20Abi,
                functionName: "approve",
                args: [rtr, amount],
                chainId: CHAIN_ID,
              }),
            async () => {
              if (!account) return false;
              const allowance = (await publicClient.readContract({
                address: asset,
                abi: erc20Abi,
                functionName: "allowance",
                args: [account, rtr],
              })) as bigint;
              return allowance >= amount;
            },
          );
          await send(
            "deposit",
            () =>
              writeContractAsync({
                address: rtr,
                abi: feeRouterAbi,
                functionName: "creatorDeposit",
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

        await send(
          "graduate",
          () =>
            writeContractAsync({
              address: FACTORY_ADDRESS!,
              abi: ballastFactoryAbi,
              functionName: "graduate",
              args: [tok],
              chainId: CHAIN_ID,
            }),
          async () => {
            const g = (await publicClient.readContract({
              address: FACTORY_ADDRESS!,
              abi: ballastFactoryAbi,
              functionName: "graduated",
              args: [tok],
            })) as boolean;
            return g;
          },
        );

        setResult({ token: tok, treasury: tre, router: router! });
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
    launchedRef.current = null;
    setLaunched(null);
    setSteps([]);
    setResult(null);
  }, []);

  return { steps, run, reset, isRunning, result, launched };
}

export type { StepStatus };
