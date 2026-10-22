// Poll recent blocks and print decoded Ballast activity (launches, swaps, burns,
// buybacks, split changes, treasury deposits, basket fills).
//   RPC=https://… npx tsx examples/watch-events.ts
import { createPublicClient, http } from "viem";
import { createBallast, robinhoodChain, parseBallastLogs } from "../src";

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
const ballast = createBallast({ publicClient });

const latest = await publicClient.getBlockNumber();
const fromBlock = latest - 1_000n; // last ~1k blocks

// Any logs in the window — parseBallastLogs keeps only recognised Ballast events.
const logs = await publicClient.getLogs({ fromBlock, toBlock: latest });
const events = parseBallastLogs(logs);
console.log(`Decoded ${events.length} Ballast events in blocks ${fromBlock}–${latest}:`);
for (const ev of events) {
  console.log(ev.kind, "·", ev.txHash, JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// Latest launches, newest first (hidden test tokens filtered out).
console.log("recent launches:", (await ballast.listLaunches({ fromBlock })).slice(0, 5).map((l) => l.token));
