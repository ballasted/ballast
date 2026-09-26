const { rpc } = require("./rpc.cjs");
const fs = require("node:fs");

function getBlockTs(numHex) {
  const b = rpc("eth_getBlockByNumber", [numHex, false]);
  return { num: parseInt(b.number, 16), ts: parseInt(b.timestamp, 16) };
}

function findBlockAtOrAfter(targetTs, hiStart) {
  let lo = 0, hi = hiStart;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const midInfo = getBlockTs("0x" + mid.toString(16));
    if (midInfo.ts >= targetTs) hi = mid; else lo = mid;
  }
  return getBlockTs("0x" + hi.toString(16));
}

const { snapshotBlock } = JSON.parse(fs.readFileSync("snapshot_block.json", "utf8"));
const T_0500 = 1790398800; // 2026-09-26 05:00:00 UTC
const T_1100 = 1790420400; // 2026-09-26 11:00:00 UTC (already known == snapshotBlock)
// anchor lower bound: 2 hours before 05:00, to find a swap to anchor the TWAP start price
const T_ANCHOR_LOWER = T_0500 - 2 * 3600;

const b0500 = findBlockAtOrAfter(T_0500, snapshotBlock);
const bAnchor = findBlockAtOrAfter(T_ANCHOR_LOWER, snapshotBlock);

const out = {
  T_ANCHOR_LOWER, T_0500, T_1100,
  blockAnchorLower: bAnchor,
  block0500: b0500,
  block1100: { num: snapshotBlock, ts: T_1100 },
};
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync("twap_range.json", JSON.stringify(out, null, 2));
