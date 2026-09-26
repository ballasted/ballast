const { rpc } = require("./rpc.cjs");
const fs = require("node:fs");

const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const POOL_ID = "0x1cada39c16e1ca109c7f5d89fedebd8d11512d1c26c17e907766733112aec6f6";
const { block1100 } = JSON.parse(fs.readFileSync("twap_range.json", "utf8"));

let calls = 0;
function fetchRangeOnce(fromBlock, toBlock) {
  calls++;
  try {
    return { ok: true, logs: rpc("eth_getLogs", [{ address: PM, topics: [SWAP_TOPIC, POOL_ID], fromBlock: "0x"+fromBlock.toString(16), toBlock: "0x"+toBlock.toString(16) }]) };
  } catch (e) { return { ok: false, err: e.message || String(e) }; }
}
function fetchRangeAdaptive(fromBlock, toBlock) {
  const queue = [[fromBlock, toBlock]];
  const results = [];
  while (queue.length) {
    const [from, to] = queue.shift();
    const size = to - from + 1;
    const r = fetchRangeOnce(from, to);
    if (r.ok) { results.push(...r.logs); }
    else {
      if (size <= 1) throw new Error("stuck: " + r.err);
      const mid = from + Math.floor(size/2) - 1;
      queue.unshift([mid+1, to]); queue.unshift([from, mid]);
    }
  }
  return results;
}

// widen backward geometrically: 8h, 24h, 72h, 168h, 720h (30d) windows per ~100ms/block => 36000 blocks/hour
const BLOCKS_PER_HOUR = 36000;
const windowsHours = [8, 24, 72, 168, 336, 720, 2160]; // up to ~90 days
let found = [];
let searchedFrom = block1100.num;
for (const h of windowsHours) {
  const from = Math.max(0, block1100.num - h * BLOCKS_PER_HOUR);
  console.log(`searching last ${h}h -> blocks [${from}, ${searchedFrom - 1}]`);
  if (from >= searchedFrom) continue;
  const logs = fetchRangeAdaptive(from, searchedFrom - 1);
  console.log(`  found ${logs.length} swap(s) in this slice`);
  found = found.concat(logs);
  searchedFrom = from;
  if (found.length > 0) break;
}
console.log("total rpc calls:", calls, "total logs found:", found.length);
found.sort((a,b) => parseInt(a.blockNumber,16) - parseInt(b.blockNumber,16));
fs.writeFileSync("last_swap_search.json", JSON.stringify(found));
if (found.length) {
  const last = found[found.length - 1];
  console.log("most recent swap before/at 11:00 UTC window: block", parseInt(last.blockNumber,16));
}
