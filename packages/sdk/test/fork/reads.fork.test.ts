import { describe, it, expect } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBallast, robinhoodChain, ADDRESSES, writes } from "../../src";

// Fork/integration reads against chain 4663. Set SDK_FORK_RPC to a 4663 RPC
// (public, or an `anvil --fork-url` endpoint). Without it, the suite is skipped
// so the default `npm test` stays offline and deterministic.
const RPC = process.env.SDK_FORK_RPC;
const run = RPC ? describe : describe.skip;

run("reads against chain 4663", () => {
  const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
  const ballast = createBallast({ publicClient });

  it("getToken resolves $BALLAST v2 identity", async () => {
    const info = await ballast.getToken(ADDRESSES.ballastV2);
    expect(info.symbol).toBeTypeOf("string");
    expect(info.totalSupply).toBeGreaterThan(0n);
  });

  it("getDeadBalance returns a non-negative bigint", async () => {
    const dead = await ballast.getDeadBalance();
    expect(dead).toBeGreaterThanOrEqual(0n);
  });

  it("getBuybackStats returns bigints", async () => {
    const s = await ballast.getBuybackStats();
    expect(s.totalBurned).toBeGreaterThanOrEqual(0n);
    expect(s.runs).toBeGreaterThanOrEqual(0n);
  });

  it("listLaunches excludes hidden test tokens", async () => {
    const all = await ballast.listLaunches({ fromBlock: 0n });
    const hidden = all.filter((l) => l.token.toLowerCase() === "0x3fec2b548755d53fd8db97cac0c14dfa99f0e335");
    expect(hidden).toHaveLength(0);
  });
});

// Simulated (never broadcast) launch: requires a funded SDK_FORK_PK on an anvil
// fork. Validates the SDK's createAndLaunch args shape against the live factory
// via simulateContract — no transaction is sent beyond the simulate.
const PK = process.env.SDK_FORK_PK as `0x${string}` | undefined;
const simRun = RPC && PK ? describe : describe.skip;
simRun("simulated launch (anvil fork)", () => {
  it("simulate createAndLaunch does not revert", async () => {
    const account = privateKeyToAccount(PK!);
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
    const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC) });
    const ctx = createBallast({ publicClient, walletClient }).ctx;
    // Only simulate — throws SimulationError if the args shape/validation is wrong.
    await expect(
      writes.launch(ctx, {
        name: "Fork Test", symbol: "FORK", metadataURI: "ipfs://x",
        quoteAssets: [ADDRESSES.weth], noticePeriod: 86400n,
        split: { creatorBps: 10000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 },
      }),
    ).resolves.toBeDefined();
  });
});
