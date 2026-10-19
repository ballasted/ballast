import "server-only";
import { getAbiItem, type Address, type ContractFunctionParameters } from "viem";
import { serverClient } from "@/lib/serverChain";
import {
  backingLensAbi,
  ballastTokenAbi,
  erc20Abi,
  projectTreasuryAbi,
  feeRouterAbi,
  feeRouterV2Abi,
  feeRouterFactoryAbi,
} from "@/lib/abis";
import { LENS_ADDRESS, FEE_ROUTER_FACTORIES } from "@/lib/contracts";

// Server-side assembly of the on-chain facts the "In plain English" summary is
// built from. Same sources the token page uses so the summary can't disagree with
// the page. Must NEVER throw — every read degrades to a missing field so a failed
// read just yields a thinner (still honest) summary, never a 500.

export type FeeSplitFacts = {
  version: 1 | 2;
  creatorBps: number;
  treasuryBps: number;
  buybackBps: number;
  rewardsBps: number;
  parentBurnBps?: number;
  parent?: Address;
};

export type SummaryFacts = {
  found: boolean;
  token: Address;
  symbol?: string;
  name?: string;
  ballasted: boolean;
  totalValueUsd?: number;
  backingPerTokenUsd?: number;
  anyStale?: boolean;
  noticePeriodDays?: number;
  feeSplit?: FeeSplitFacts;
};

export type SummaryAssembly = { facts: SummaryFacts; blockBucket: number };

const WAD = 10n ** 18n;

// Bucket the block height so the per-token cache key is stable for ~a minute at a
// time (blocks are ~100ms here → ~600 blocks/min). "Cache per token + block range."
const BLOCK_BUCKET_SIZE = 600n;

function to1e18Number(v: bigint): number {
  // Scaled-1e18 USD → float. Fine for display precision in a sentence.
  return Number(v) / 1e18;
}

async function readBlockBucket(client: ReturnType<typeof serverClient>): Promise<number> {
  try {
    const bn = await client.getBlockNumber();
    return Number(bn / BLOCK_BUCKET_SIZE);
  } catch {
    return 0;
  }
}

// Find the token's FeeRouter the same way the client hook does: scan
// FeeRouterCreated across configured factories, then match each candidate's
// token(). Best-effort — any failure leaves the split undefined.
async function readFeeSplit(
  client: ReturnType<typeof serverClient>,
  token: Address,
): Promise<FeeSplitFacts | undefined> {
  if (FEE_ROUTER_FACTORIES.length === 0) return undefined;
  try {
    const latest = await client.getBlockNumber();
    const candidates: { router: Address; version: 1 | 2 }[] = [];
    for (const f of FEE_ROUTER_FACTORIES) {
      const logs = await client.getLogs({
        address: f.address,
        event: getAbiItem({ abi: feeRouterFactoryAbi, name: "FeeRouterCreated" }),
        fromBlock: 0n,
        toBlock: latest,
      });
      for (const l of logs) {
        const router = (l as unknown as { args: { router?: Address } }).args.router;
        if (router) candidates.push({ router, version: f.version });
      }
    }
    if (candidates.length === 0) return undefined;

    const tokenReads = await client.multicall({
      allowFailure: true,
      contracts: candidates.map(
        (c) => ({ address: c.router, abi: feeRouterAbi, functionName: "token" }) as ContractFunctionParameters,
      ),
    });
    let match: { router: Address; version: 1 | 2 } | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const r = tokenReads[i];
      if (r?.status === "success" && (r.result as Address).toLowerCase() === token.toLowerCase()) {
        match = candidates[i];
        break;
      }
    }
    if (!match) return undefined;

    const abi = match.version === 2 ? feeRouterV2Abi : feeRouterAbi;
    const fns = ["creatorBps", "treasuryBps", "buybackBps", "rewardsBps"] as const;
    const extra = match.version === 2 ? (["parentBurnBps", "parent"] as const) : ([] as const);
    const reads = await client.multicall({
      allowFailure: true,
      contracts: [...fns, ...extra].map(
        (fn) => ({ address: match!.router, abi, functionName: fn }) as ContractFunctionParameters,
      ),
    });
    const num = (i: number) => (reads[i]?.status === "success" ? Number(reads[i].result as number) : 0);
    const split: FeeSplitFacts = {
      version: match.version,
      creatorBps: num(0),
      treasuryBps: num(1),
      buybackBps: num(2),
      rewardsBps: num(3),
    };
    if (match.version === 2) {
      split.parentBurnBps = num(4);
      const p = reads[5];
      if (p?.status === "success") {
        const parent = p.result as Address;
        if (parent && !/^0x0+$/.test(parent)) split.parent = parent;
      }
    }
    return split;
  } catch {
    return undefined;
  }
}

export async function assembleSummaryData(token: Address): Promise<SummaryAssembly> {
  const client = serverClient();
  const blockBucket = await readBlockBucket(client);
  const base: SummaryFacts = { found: false, token, ballasted: false };

  // treasury() — the immutable pointer. Absent → not a BALLAST token here.
  let treasury: Address | undefined;
  try {
    treasury = (await client.readContract({
      address: token,
      abi: ballastTokenAbi,
      functionName: "treasury",
    })) as Address;
  } catch {
    return { facts: base, blockBucket };
  }
  if (!treasury || /^0x0+$/.test(treasury)) return { facts: base, blockBucket };

  const facts: SummaryFacts = { ...base, found: true };

  // Metadata + backing + notice period in one batch.
  try {
    const contracts: ContractFunctionParameters[] = [
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "name" },
      { address: treasury, abi: projectTreasuryAbi, functionName: "noticePeriod" },
    ];
    if (LENS_ADDRESS)
      contracts.push({ address: LENS_ADDRESS, abi: backingLensAbi, functionName: "backingOf", args: [treasury] });
    const reads = await client.multicall({ allowFailure: true, contracts });
    if (reads[0]?.status === "success") facts.symbol = reads[0].result as string;
    if (reads[1]?.status === "success") facts.name = reads[1].result as string;
    if (reads[2]?.status === "success") {
      facts.noticePeriodDays = Math.round(Number(reads[2].result as bigint) / 86400);
    }
    if (LENS_ADDRESS && reads[3]?.status === "success") {
      const b = reads[3].result as unknown as {
        totalValueUsd: bigint;
        backingPerToken: bigint;
        anyStale: boolean;
      };
      facts.ballasted = b.totalValueUsd > 0n;
      facts.totalValueUsd = to1e18Number(b.totalValueUsd);
      facts.backingPerTokenUsd = to1e18Number(b.backingPerToken);
      facts.anyStale = b.anyStale;
    }
  } catch {
    // keep whatever we have
  }

  facts.feeSplit = await readFeeSplit(client, token);
  return { facts, blockBucket };
}

// ── Pure prompt assembly (unit-testable without a chain) ──────────────────────
function pct(bps: number): number {
  return Math.round((bps / 10000) * 100);
}

/** Turn assembled facts into the user message for the summary model. Pure. */
export function factsToPrompt(facts: SummaryFacts): string {
  const lines: string[] = [];
  lines.push(`Token: ${facts.name ?? "(name withheld)"} (${facts.symbol ?? "?"})`);
  lines.push(`Address: ${facts.token}`);
  if (facts.ballasted && facts.totalValueUsd !== undefined) {
    lines.push(`Treasury backing: YES.`);
    lines.push(`Total treasury value (USD): ${facts.totalValueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
    if (facts.backingPerTokenUsd !== undefined)
      lines.push(`Backing per token (USD, live on-chain figure): ${facts.backingPerTokenUsd.toPrecision(4)}`);
    if (facts.anyStale) lines.push(`Note: at least one asset's price feed is currently resting/stale.`);
  } else {
    lines.push(`Treasury backing: NONE (this token is not currently backed).`);
  }
  if (facts.noticePeriodDays !== undefined) {
    lines.push(`Creator withdrawal notice period: ${facts.noticePeriodDays} days (immutable).`);
  }
  if (facts.feeSplit) {
    const s = facts.feeSplit;
    const parts = [
      `creator ${pct(s.creatorBps)}%`,
      `treasury ${pct(s.treasuryBps)}%`,
      `buyback & burn ${pct(s.buybackBps)}%`,
      `stakers ${pct(s.rewardsBps)}%`,
    ];
    if (s.version === 2 && s.parentBurnBps) parts.push(`parent-burn ${pct(s.parentBurnBps)}%`);
    lines.push(`Fee split (of the creator's share of trading fees): ${parts.join(", ")}.`);
  } else {
    lines.push(`Fee split: no fee router configured for this token.`);
  }
  lines.push(
    `Reminder: holding this token gives no claim, redemption right, or entitlement to the treasury assets.`,
  );
  return lines.join("\n");
}
