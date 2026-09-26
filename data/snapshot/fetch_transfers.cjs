const { rpc } = require("./rpc.cjs");
const fs = require("node:fs");

const V1 = "0x069a260370c61d91bd3e9842d81d378f9750f7f3";
const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const { snapshotBlock } = JSON.parse(fs.readFileSync("snapshot_block.json", "utf8"));

let calls = 0;
const results = [];
const MIN_CHUNK = 1; // don't split below 1 block

function sleep(ms) { const end = Date.now() + ms; while (Date.now() < end) {} }

function fetchRangeOnce(fromBlock, toBlock, attempt) {
  calls++;
  const fromHex = "0x" + fromBlock.toString(16);
  const toHex = "0x" + toBlock.toString(16);
  try {
    return { ok: true, logs: rpc("eth_getLogs", [{ address: V1, topics: [TRANSFER_SIG], fromBlock: fromHex, toBlock: toHex }]) };
  } catch (e) {
    return { ok: false, err: e.message || String(e) };
  }
}

// queue-based, iterative (avoid deep recursion), initial coarse chunking
const queue = [];
const INITIAL_CHUNK = 2_000_000;
for (let start = 0; start <= snapshotBlock; start += INITIAL_CHUNK) {
  queue.push([start, Math.min(start + INITIAL_CHUNK - 1, snapshotBlock)]);
}

let totalLogs = 0;
const t0 = Date.now();
while (queue.length) {
  const [from, to] = queue.shift();
  const size = to - from + 1;
  const r = fetchRangeOnce(from, to);
  if (r.ok) {
    results.push(...r.logs);
    totalLogs += r.logs.length;
    if (r.logs.length > 0 || size <= 50000) {
      console.log(`OK  [${from}, ${to}] size=${size} logs=${r.logs.length} totalSoFar=${totalLogs} queueLeft=${queue.length}`);
    }
  } else {
    if (size <= MIN_CHUNK) {
      console.log(`GIVING UP on single block ${from}: ${r.err}`);
      throw new Error("cannot shrink further: " + r.err);
    }
    const mid = from + Math.floor(size / 2) - 1;
    queue.unshift([mid + 1, to]);
    queue.unshift([from, mid]);
    // small backoff on repeated failures to be nice to the rate limit
  }
}

console.log("DONE total logs:", totalLogs, "rpc calls:", calls, "elapsed s:", ((Date.now()-t0)/1000).toFixed(1));

results.sort((a, b) => {
  const ba = parseInt(a.blockNumber, 16), bb = parseInt(b.blockNumber, 16);
  if (ba !== bb) return ba - bb;
  return parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16);
});

fs.writeFileSync("transfers_raw.json", JSON.stringify(results));
if (results.length) {
  console.log("first log block:", parseInt(results[0].blockNumber,16), "last log block:", parseInt(results[results.length-1].blockNumber,16));
}
