const { rpc, rpcBatch } = require("./rpc.cjs");
const fs = require("node:fs");

const V1 = "0x069a260370c61d91bd3e9842d81d378f9750f7f3";
const { snapshotBlock } = JSON.parse(fs.readFileSync("snapshot_block.json", "utf8"));
const logs = JSON.parse(fs.readFileSync("transfers_raw.json", "utf8"));

function topicToAddress(topic) {
  return "0x" + topic.slice(26);
}

const balances = new Map();
function add(addr, delta) {
  const cur = balances.get(addr) || 0n;
  balances.set(addr, cur + delta);
}

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000".slice(0,42); // placeholder unused

for (const log of logs) {
  const from = topicToAddress(log.topics[1]);
  const to = topicToAddress(log.topics[2]);
  const value = BigInt(log.data);
  if (from !== "0x0000000000000000000000000000000000000000") add(from, -value);
  if (to !== "0x0000000000000000000000000000000000000000") add(to, value);
}

// sanity: sum of all balances should equal totalSupply()
let sum = 0n;
for (const v of balances.values()) sum += v;

const snapshotBlockHex = "0x" + snapshotBlock.toString(16);
const [totalSupplyHex] = rpcBatch([
  { method: "eth_call", params: [{ to: V1, data: "0x18160ddd" }, "latest"] }, // totalSupply()
]);
const totalSupply = BigInt(totalSupplyHex);

console.log("reconstructed sum of balances:", sum.toString());
console.log("on-chain totalSupply() at snapshot block:", totalSupply.toString());
console.log("match:", sum === totalSupply);

// drop zero/negative-dust balances (shouldn't happen, but guard)
const holders = [...balances.entries()].filter(([addr, bal]) => bal > 0n);
console.log("nonzero holder addresses:", holders.length);

fs.writeFileSync("balances_raw.json", JSON.stringify(holders.map(([a,b]) => [a, b.toString()])));
fs.writeFileSync("supply_check.json", JSON.stringify({ sum: sum.toString(), totalSupply: totalSupply.toString(), match: sum === totalSupply }, null, 2));
