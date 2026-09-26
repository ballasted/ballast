const { rpc } = require("./rpc.cjs");
const fs = require("node:fs");

const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const POOL_ID = "0x1cada39c16e1ca109c7f5d89fedebd8d11512d1c26c17e907766733112aec6f6";

const { blockAnchorLower, block1100 } = JSON.parse(fs.readFileSync("twap_range.json", "utf8"));

let calls = 0;
function fetchRangeOnce(fromBlock, toBlock) {
  calls++;
  try {
    return { ok: true, logs: rpc("eth_getLogs", [{ address: PM, topics: [SWAP_TOPIC, POOL_ID], fromBlock: "0x"+fromBlock.toString(16), toBlock: "0x"+toBlock.toString(16) }]) };
  } catch (e) { return { ok: false, err: e.message || String(e) }; }
}

const queue = [[blockAnchorLower.num, block1100.num]];
const results = [];
while (queue.length) {
  const [from, to] = queue.shift();
  const size = to - from + 1;
  const r = fetchRangeOnce(from, to);
  if (r.ok) {
    results.push(...r.logs);
    console.log(`OK [${from},${to}] size=${size} logs=${r.logs.length}`);
  } else {
    if (size <= 1) throw new Error("cannot shrink further: " + r.err);
    const mid = from + Math.floor(size/2) - 1;
    queue.unshift([mid+1, to]);
    queue.unshift([from, mid]);
  }
}
console.log("total swap logs:", results.length, "rpc calls:", calls);
results.sort((a,b) => {
  const ba = parseInt(a.blockNumber,16), bb = parseInt(b.blockNumber,16);
  if (ba !== bb) return ba - bb;
  return parseInt(a.logIndex,16) - parseInt(b.logIndex,16);
});
fs.writeFileSync("swaps_raw.json", JSON.stringify(results));
