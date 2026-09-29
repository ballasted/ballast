// Compute per-holder ETH claim amounts for the v1->v2 migration (decision A:
// pay in ETH, sized by USD value at snapshot, converted at the historical
// ETH/USD price AT THE SNAPSHOT BLOCK). All arithmetic in BigInt to avoid any
// floating-point error on financial amounts.
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const raw = JSON.parse(fs.readFileSync(path.join(DIR, "balances_raw.json"), "utf8"));
const rawMap = new Map(raw.map(([addr, bal]) => [addr.toLowerCase(), BigInt(bal)]));

const csv = fs.readFileSync(path.join(DIR, "v1_snapshot.csv"), "utf8").trim().split("\n");
const header = csv[0];
const rows = csv.slice(1).map((line) => {
  const [address, balance, usd_value, share] = line.split(",");
  return { address, balance, usd_value, share };
});

// TWAP price, USD per v1 token, exact decimal string from meta.json (21 digits
// after the point) -> numerator/denominator as BigInt, no float.
const TWAP_STR = "0.000007100633157926953"; // meta.json priceUsd, verbatim
const [, twapFrac] = TWAP_STR.split(".");
const TWAP_NUM = BigInt(twapFrac.replace(/^0+(?=\d)/, "") || "0");
const TWAP_DEN = 10n ** BigInt(twapFrac.length);

// Historical ETH/USD at the exact snapshot block (73030228), read live this
// session via `cast call <feed> latestRoundData() --block 73030228`.
const ETHUSD_ANSWER = 268681000000n; // raw feed answer
const ETHUSD_DECIMALS = 8n;
const ETHUSD_NUM = ETHUSD_ANSWER;
const ETHUSD_DEN = 10n ** ETHUSD_DECIMALS;

let totalEthWei = 0n;
const out = [];
for (const r of rows) {
  const addr = r.address.toLowerCase();
  const balanceWei = rawMap.get(addr);
  if (balanceWei === undefined) throw new Error(`no raw balance for ${addr}`);
  // ethAmountWei = balanceWei * (TWAP_NUM/TWAP_DEN) / (ETHUSD_NUM/ETHUSD_DEN)
  //             = balanceWei * TWAP_NUM * ETHUSD_DEN / (TWAP_DEN * ETHUSD_NUM)
  const ethAmountWei = (balanceWei * TWAP_NUM * ETHUSD_DEN) / (TWAP_DEN * ETHUSD_NUM);
  totalEthWei += ethAmountWei;
  out.push({ address: addr, balanceWei: balanceWei.toString(), usd_value: r.usd_value, ethAmountWei: ethAmountWei.toString() });
}

// Human-readable ETH for the CSV (18 decimals, truncated display only -- the
// wei value above is the source of truth for the contract/Merkle tree).
function weiToEthStr(wei) {
  const neg = wei < 0n;
  wei = neg ? -wei : wei;
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 8);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

const outCsv = ["address,snapshotBalanceWei,usdValue,ethAmountWei,ethAmount"];
for (const r of out) {
  outCsv.push(`${r.address},${r.balanceWei},${r.usd_value},${r.ethAmountWei},${weiToEthStr(BigInt(r.ethAmountWei))}`);
}
fs.writeFileSync(path.join(DIR, "v1_claim_eth.csv"), outCsv.join("\n") + "\n");

console.log("holders:", out.length);
console.log("total ETH wei:", totalEthWei.toString());
console.log("total ETH:", weiToEthStr(totalEthWei));
fs.writeFileSync(
  path.join(DIR, "v1_claim_eth_meta.json"),
  JSON.stringify(
    {
      snapshotBlock: 73030228,
      twapUsdPerToken: TWAP_STR,
      ethUsdAtSnapshotBlock: { answer: ETHUSD_ANSWER.toString(), decimals: Number(ETHUSD_DECIMALS), asDecimal: "2686.81" },
      holders: out.length,
      totalEthWei: totalEthWei.toString(),
      totalEth: weiToEthStr(totalEthWei),
    },
    null,
    2,
  ),
);
