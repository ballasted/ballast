import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { basketZapAbi } from "./basketZapAbi";
import { projectTreasuryWriteAbi } from "./abis";

// EIP-5792 (wallet_sendCalls / wallet_getCapabilities) support helpers for the
// basket flow. Pure functions so capability detection and call-building are
// unit-testable without a wallet (lib/eip5792.test.ts).

export type AtomicStatus = "supported" | "ready" | "unsupported" | "unknown";

type RawCapabilities = Record<number, Record<string, unknown>> | undefined;

/** Normalize the atomic-batch capability across EIP-5792 spec revisions:
 *  current:    { atomic: { status: "supported" | "ready" | "unsupported" } }
 *  older draft { atomicBatch: { supported: boolean } }
 *  Returns "unknown" when the wallet reports nothing for this chain. */
export function atomicStatusFor(capabilities: RawCapabilities, chainId: number): AtomicStatus {
  const c = capabilities?.[chainId];
  if (!c) return "unknown";
  const atomic = c.atomic as { status?: string } | undefined;
  if (atomic?.status === "supported" || atomic?.status === "ready" || atomic?.status === "unsupported") {
    return atomic.status;
  }
  const legacy = c.atomicBatch as { supported?: boolean } | undefined;
  if (typeof legacy?.supported === "boolean") return legacy.supported ? "supported" : "unsupported";
  return "unknown";
}

/** True when the connected wallet can execute an atomic batch on this chain —
 *  i.e. a single confirmation that is all-or-nothing across every call. */
export function supportsAtomicBatch(capabilities: RawCapabilities, chainId: number): boolean {
  const s = atomicStatusFor(capabilities, chainId);
  return s === "supported" || s === "ready";
}

export type BatchLeg = {
  asset: Address;
  weightBps: number;
  preferFables: boolean;
  fablesHopIdx: bigint[];
  ramsesHopIdx: bigint[];
  minOut: bigint;
};

export type BasketCall = { to: Address; data: `0x${string}`; value?: bigint };

/** Build the EIP-5792 call list for the whole basket in one atomic batch:
 *  [ swapBasket(value=ethIn), then per leg: approve(treasury, minOut),
 *  deposit(asset, minOut) ].
 *
 *  Deposit amount is each leg's minOut (the swap's guaranteed floor), NOT the
 *  exact received amount: the calls are pre-encoded, so they can't read the
 *  swap's actual output. Since the contract guarantees `received >= minOut`,
 *  approve+deposit of minOut always succeeds inside the batch; any surplus from
 *  a better-than-quoted swap stays in the creator's wallet and can be added
 *  later via the "Resume deposit" banner. This is the price of atomicity — one
 *  confirmation, all-or-nothing — and is surfaced in the UI. */
export function buildBasketCalls(args: {
  basketZap: Address;
  launchToken: Address;
  treasury: Address;
  ethIn: bigint;
  legs: BatchLeg[];
  deadline: bigint;
}): BasketCall[] {
  const { basketZap, launchToken, treasury, ethIn, legs, deadline } = args;
  const calls: BasketCall[] = [
    {
      to: basketZap,
      value: ethIn,
      data: encodeFunctionData({
        abi: basketZapAbi,
        functionName: "swapBasket",
        args: [
          launchToken,
          legs.map((l) => ({
            asset: l.asset,
            weightBps: l.weightBps,
            preferFables: l.preferFables,
            fablesHopIdx: l.fablesHopIdx,
            ramsesHopIdx: l.ramsesHopIdx,
            minOut: l.minOut,
          })),
          deadline,
        ],
      }),
    },
  ];
  for (const l of legs) {
    calls.push({
      to: l.asset,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [treasury, l.minOut] }),
    });
    calls.push({
      to: treasury,
      data: encodeFunctionData({ abi: projectTreasuryWriteAbi, functionName: "deposit", args: [l.asset, l.minOut] }),
    });
  }
  return calls;
}

/** Signature/confirmation count the user will face, for upfront display.
 *  Batched: always 1. Step flow: 1 (swap) + one `deposit` per leg + one
 *  `approve` per leg whose current treasury allowance is below its minOut
 *  (approvals already covered are skipped). */
export function stepSignatureCount(legs: { minOut: bigint }[], allowances: bigint[]): number {
  let n = 1; // swap
  legs.forEach((l, i) => {
    n += 1; // deposit
    if ((allowances[i] ?? 0n) < l.minOut) n += 1; // approve
  });
  return n;
}
