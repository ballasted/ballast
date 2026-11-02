import { describe, it, expect } from "vitest";
import {
  balancesFromTransfers,
  countHolders,
  holdersMilestoneReachedTs,
  firstFundingSource,
  detectClusters,
  computeHolders,
  type Transfer,
} from "./holders";

const A = (c: string) => `0x${c.repeat(40).slice(0, 40)}` as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const POOL = A("9"); // stand-in "system" address
const LAUNCH = 1_000;

function t(from: string, to: string, value: bigint, blockTs: number, logIndex = 0): Transfer {
  return { from: from as `0x${string}`, to: to as `0x${string}`, value, blockNumber: blockTs, blockTs, logIndex };
}

describe("balancesFromTransfers", () => {
  it("nets balances and conserves supply (incl. the zero address)", () => {
    const transfers = [t(ZERO, A("a"), 100n, 10), t(A("a"), A("b"), 40n, 20), t(A("b"), A("c"), 10n, 30)];
    const bal = balancesFromTransfers(transfers);
    expect(bal.get(A("a").toLowerCase())).toBe(60n);
    expect(bal.get(A("b").toLowerCase())).toBe(30n);
    expect(bal.get(A("c").toLowerCase())).toBe(10n);
    // Conservation: all deltas (including the −100 mint on the zero address) sum to 0.
    let sum = 0n;
    for (const v of bal.values()) sum += v;
    expect(sum).toBe(0n);
  });
});

describe("countHolders", () => {
  it("counts non-zero balances, excluding system + zero addresses", () => {
    const bal = new Map<string, bigint>([
      [A("a").toLowerCase(), 10n],
      [A("b").toLowerCase(), 5n],
      [POOL.toLowerCase(), 999n], // excluded
      [ZERO, 1n], // zero addr never counts
      [A("c").toLowerCase(), 0n], // zero balance
    ]);
    const exclude = new Set([POOL.toLowerCase()]);
    expect(countHolders(bal, exclude)).toBe(2);
  });
});

describe("holdersMilestoneReachedTs", () => {
  it("returns the first in-window ts the clean count reaches the target", () => {
    const transfers = [
      t(POOL, A("a"), 10n, 1100),
      t(POOL, A("b"), 10n, 1200),
      t(POOL, A("c"), 10n, 1300), // 3rd distinct holder here
    ];
    const exclude = new Set([POOL.toLowerCase()]);
    expect(holdersMilestoneReachedTs(transfers, exclude, LAUNCH, 3)).toBe(1300);
    expect(holdersMilestoneReachedTs(transfers, exclude, LAUNCH, 4)).toBeNull();
  });

  it("does not count a holder that later drops to zero balance", () => {
    const transfers = [
      t(POOL, A("a"), 10n, 1100),
      t(POOL, A("b"), 10n, 1200),
      t(A("b"), POOL, 10n, 1250), // b exits before a 3rd ever arrives
      t(POOL, A("c"), 10n, 1300),
    ];
    const exclude = new Set([POOL.toLowerCase()]);
    // Max simultaneous clean holders is 2 (a + c), never 3.
    expect(holdersMilestoneReachedTs(transfers, exclude, LAUNCH, 3)).toBeNull();
  });

  it("ignores a milestone reached only after the window closes", () => {
    const late = 9_000_000;
    const transfers = [t(POOL, A("a"), 10n, late), t(POOL, A("b"), 10n, late + 1)];
    expect(holdersMilestoneReachedTs(transfers, new Set([POOL.toLowerCase()]), LAUNCH, 2)).toBeNull();
  });
});

describe("detectClusters", () => {
  it("flags holders funded from one non-system source, not pool-funded buyers", () => {
    const S = A("5"); // a sybil funder EOA
    const transfers = [
      // Pool funds three ordinary buyers — must NOT cluster (pool is excluded).
      t(POOL, A("a"), 10n, 1100),
      t(POOL, A("b"), 10n, 1100, 1),
      t(POOL, A("c"), 10n, 1100, 2),
      // One source S funds three wallets — a cluster.
      t(S, A("d"), 10n, 1200),
      t(S, A("e"), 10n, 1200, 1),
      t(S, A("f"), 10n, 1200, 2),
    ];
    const bal = balancesFromTransfers(transfers);
    const src = firstFundingSource(transfers);
    const exclude = new Set([POOL.toLowerCase()]);
    const flagged = detectClusters(bal, src, exclude, 3);
    const flaggedAddrs = new Set(flagged.map((f) => f.holder.toLowerCase()));
    expect(flagged.length).toBe(3);
    expect(flaggedAddrs.has(A("d").toLowerCase())).toBe(true);
    expect(flaggedAddrs.has(A("a").toLowerCase())).toBe(false); // pool-funded, not a cluster
    expect(flagged[0]!.fundedBy.toLowerCase()).toBe(S.toLowerCase());
    expect(flagged[0]!.clusterSize).toBe(3);
  });
});

describe("computeHolders", () => {
  it("runs the full pipeline and respects exclusions", () => {
    const transfers = [t(POOL, A("a"), 10n, 1100), t(POOL, A("b"), 10n, 1200)];
    const r = computeHolders(transfers, new Set([POOL.toLowerCase()]), LAUNCH);
    expect(r.holders).toBe(2);
    expect(r.flaggedHolders).toEqual([]);
  });
});
