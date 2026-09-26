const { rpcBatch } = require("./rpc.cjs");
const fs = require("node:fs");

const holders = JSON.parse(fs.readFileSync("balances_raw.json", "utf8")); // [[addr, balStr], ...]
const DEPLOYER = "0xa2774e53dcb666799dba7d00dc11d10d7ff837d1";
const SAFE = "0xefc97e16a24d2434c7138a2634e554a0631ac079";
const BURN = "0x000000000000000000000000000000000000dead";

function chunk(arr, n) { const out = []; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

const addrs = holders.map(([a]) => a);
const codeMap = {};
for (const batch of chunk(addrs, 25)) {
  const calls = batch.map(a => ({ method: "eth_getCode", params: [a, "latest"] }));
  const results = rpcBatch(calls);
  batch.forEach((a, i) => { codeMap[a] = results[i]; });
}

const rows = holders.map(([addr, balStr]) => {
  const isContract = codeMap[addr] && codeMap[addr] !== "0x";
  const lower = addr.toLowerCase();
  let excludeReason = null;
  if (lower === DEPLOYER) excludeReason = "deployer";
  else if (lower === SAFE) excludeReason = "safe";
  else if (lower === BURN) excludeReason = "burn/dead";
  else if (isContract) excludeReason = "contract";
  return { address: addr, balance: balStr, isContract: !!isContract, excludeReason };
});

fs.writeFileSync("classified.json", JSON.stringify(rows, null, 2));

const excluded = rows.filter(r => r.excludeReason);
const included = rows.filter(r => !r.excludeReason);
console.log("excluded:", excluded.length, "included:", included.length);
console.log("--- excluded detail ---");
for (const r of excluded.sort((a,b) => BigInt(b.balance) - BigInt(a.balance) > 0n ? 1 : -1)) {
  console.log(r.excludeReason.padEnd(10), r.address, (BigInt(r.balance) / 10n**18n).toString());
}
