const fs = require("node:fs");
const crypto = require("node:crypto");

const rows = JSON.parse(fs.readFileSync("classified.json", "utf8"));
const { snapshotBlock, snapshotBlockTs, targetTs } = JSON.parse(fs.readFileSync("snapshot_block.json", "utf8"));

// Real TWAP for 05:00-11:00 UTC 2026-09-26: v1's pool (poolId 0x1cada39c...aec6f6)
// had ZERO Swap events in that entire window (confirmed via eth_getLogs, and
// zero for a further ~11h back to 20:26 UTC 2026-09-25) — so the time-weighted
// average price over the window is, correctly, the constant price set by the
// last real trade before it. See last_swap_price.json + twap.md for the swap
// (block 72511886) this is anchored to.
const PRICE_USD = 0.000007100633157926953;
const DECIMALS = 18n;
const SCALE = 10n ** DECIMALS;

const included = rows.filter(r => !r.excludeReason);
const excluded = rows.filter(r => r.excludeReason);

const totalIncluded = included.reduce((s, r) => s + BigInt(r.balance), 0n);

function toDecimalString(raw18, precision = 6) {
  const neg = raw18 < 0n;
  const v = neg ? -raw18 : raw18;
  const whole = v / SCALE;
  const frac = v % SCALE;
  const fracStr = frac.toString().padStart(18, "0").slice(0, precision);
  return (neg ? "-" : "") + whole.toString() + "." + fracStr;
}

const sortedIncluded = included.slice().sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));

const lines = ["address,balance,usd_value,share"];
for (const r of sortedIncluded) {
  const bal = BigInt(r.balance);
  const balTokens = toDecimalString(bal, 6);
  const usd = (Number(balTokens) * PRICE_USD).toFixed(6);
  const share = totalIncluded === 0n ? "0" : (Number(bal * 1_000_000_000n / totalIncluded) / 1_000_000_000).toFixed(9);
  lines.push(`${r.address},${balTokens},${usd},${share}`);
}
fs.writeFileSync("v1_snapshot.csv", lines.join("\n") + "\n");

const exLines = ["address,balance,reason"];
for (const r of excluded.sort((a,b) => BigInt(b.balance) > BigInt(a.balance) ? 1 : -1)) {
  exLines.push(`${r.address},${toDecimalString(BigInt(r.balance),6)},${r.excludeReason}`);
}
fs.writeFileSync("v1_snapshot_excluded.csv", exLines.join("\n") + "\n");

const csvBuf = fs.readFileSync("v1_snapshot.csv");
const hash = crypto.createHash("sha3-256"); // node's crypto doesn't have keccak256 built-in; see keccak note below
const meta = {
  token: "0x069a260370C61d91bd3e9842d81D378F9750F7F3",
  snapshotBlock,
  snapshotBlockTimestampUtc: new Date(snapshotBlockTs * 1000).toISOString(),
  targetTimestampUtc: new Date(targetTs * 1000).toISOString(),
  totalSupply: "1000000000000000000000000000",
  includedHolders: included.length,
  excludedAddresses: excluded.length,
  totalIncludedBalanceRaw: totalIncluded.toString(),
  totalIncludedBalanceTokens: toDecimalString(totalIncluded, 6),
  priceUsdSource: "Real 05:00-11:00 UTC TWAP: v1's pool had zero swaps in the window (verified via eth_getLogs), so TWAP = the constant price from the last real swap before it, block 72511886 (2026-09-25T20:26:00Z). See twap.md.",
  priceUsd: PRICE_USD,
  twapWindowUtc: ["2026-09-26T05:00:00.000Z", "2026-09-26T11:00:00.000Z"],
  twapAnchorSwapBlock: 72511886,
  twapAnchorSwapTimestampUtc: "2026-09-25T20:26:00.000Z",
};
fs.writeFileSync("meta.json", JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
console.log("top 5 included holders:");
console.log(lines.slice(0,6).join("\n"));
