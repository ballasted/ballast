// ─────────────────────────────────────────────────────────────────────────────
// Creator Fund — holder counting + cluster flags. PURE, unit-tested.
//
// Holders are reconstructed from the token's ERC-20 Transfer events (net balance per
// address). We count addresses with a NON-ZERO balance, EXCLUDING a fixed set of
// system addresses (pool manager, treasury, fee router, dead, creator, Ramses
// locker, routers, seeders, platform vaults, …; built in exclusions.ts). The
// 100-holder milestone time is the first in-window moment the clean count reaches
// 100. We also flag clusters: ≥N holders whose FIRST inbound transfer came from the
// same non-system source wallet (a sybil/airdrop pattern) — flagged, never removed.
// ─────────────────────────────────────────────────────────────────────────────
import type { Address } from "viem";
import { MILESTONE_HOLDERS, withinWindow, type FlaggedHolder } from "../creatorFund";

export type Transfer = {
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: number;
  blockTs: number;
  logIndex: number;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: Address | string): string => a.toLowerCase();

/** Pure: net balances per address from a transfer list. */
export function balancesFromTransfers(transfers: Transfer[]): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  const add = (a: string, v: bigint) => bal.set(a, (bal.get(a) ?? 0n) + v);
  for (const t of transfers) {
    add(lc(t.from), -t.value);
    add(lc(t.to), t.value);
  }
  return bal;
}

/** Whether an address counts as a real holder: non-zero balance, not zero addr, not excluded. */
function isCountable(addr: string, balance: bigint, exclude: Set<string>): boolean {
  return balance > 0n && addr !== ZERO && !exclude.has(addr);
}

/** Pure: count non-zero holders after exclusions. */
export function countHolders(balances: Map<string, bigint>, exclude: Set<string>): number {
  let n = 0;
  for (const [addr, bal] of balances) if (isCountable(addr, bal, exclude)) n++;
  return n;
}

/**
 * Pure: first in-window timestamp the clean holder count reaches `target` (default
 * 100). Replays transfers chronologically, maintaining balances and live
 * membership. Returns null if never reached in-window.
 */
export function holdersMilestoneReachedTs(
  transfers: Transfer[],
  exclude: Set<string>,
  launchTs: number,
  target = MILESTONE_HOLDERS,
): number | null {
  const sorted = [...transfers].sort((a, b) => a.blockTs - b.blockTs || a.logIndex - b.logIndex);
  const bal = new Map<string, bigint>();
  const member = new Set<string>();
  let count = 0;

  const touch = (addr: string, delta: bigint) => {
    const next = (bal.get(addr) ?? 0n) + delta;
    bal.set(addr, next);
    const should = isCountable(addr, next, exclude);
    const has = member.has(addr);
    if (should && !has) {
      member.add(addr);
      count++;
    } else if (!should && has) {
      member.delete(addr);
      count--;
    }
  };

  for (const t of sorted) {
    touch(lc(t.from), -t.value);
    touch(lc(t.to), t.value);
    if (count >= target && withinWindow(launchTs, t.blockTs)) return t.blockTs;
  }
  return null;
}

/** Pure: map holder → the `from` of their FIRST inbound (value>0) transfer. */
export function firstFundingSource(transfers: Transfer[]): Map<string, string> {
  const src = new Map<string, string>();
  const sorted = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const t of sorted) {
    if (t.value <= 0n) continue;
    const to = lc(t.to);
    if (!src.has(to)) src.set(to, lc(t.from));
  }
  return src;
}

/**
 * Pure: clusters of current (countable) holders sharing the same non-system funding
 * source. `exclude` is applied to BOTH the holders considered and the candidate
 * source (so the pool/router/system sources — which legitimately fund everyone —
 * never form a cluster). Clusters of size ≥ `minClusterSize` are flagged.
 */
export function detectClusters(
  balances: Map<string, bigint>,
  source: Map<string, string>,
  exclude: Set<string>,
  minClusterSize = 3,
): FlaggedHolder[] {
  const bySource = new Map<string, string[]>();
  for (const [addr, bal] of balances) {
    if (!isCountable(addr, bal, exclude)) continue;
    const s = source.get(addr);
    if (!s || s === ZERO || exclude.has(s)) continue; // skip mints + system-funded
    const arr = bySource.get(s);
    if (arr) arr.push(addr);
    else bySource.set(s, [addr]);
  }

  const flagged: FlaggedHolder[] = [];
  for (const [s, holders] of bySource) {
    if (holders.length < minClusterSize) continue;
    for (const h of holders) {
      flagged.push({
        holder: h as Address,
        balance: (balances.get(h) ?? 0n).toString(),
        reason: "cluster_same_source",
        fundedBy: s as Address,
        clusterSize: holders.length,
      });
    }
  }
  // Largest clusters first.
  flagged.sort((a, b) => b.clusterSize - a.clusterSize);
  return flagged;
}

export type HoldersResult = {
  holders: number;
  holdersMilestoneReachedTs: number | null;
  flaggedHolders: FlaggedHolder[];
};

/** Pure: full holder computation from a transfer list. */
export function computeHolders(
  transfers: Transfer[],
  exclude: Set<string>,
  launchTs: number,
  opts?: { minClusterSize?: number },
): HoldersResult {
  const balances = balancesFromTransfers(transfers);
  const source = firstFundingSource(transfers);
  return {
    holders: countHolders(balances, exclude),
    holdersMilestoneReachedTs: holdersMilestoneReachedTs(transfers, exclude, launchTs),
    flaggedHolders: detectClusters(balances, source, exclude, opts?.minClusterSize ?? 3),
  };
}
