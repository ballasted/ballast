// For each launched BallastToken, extract the exact constructor-args tail from
// its on-chain creation bytecode (Blockscout) by subtracting the locally
// compiled creation code. Emits a table + writes tokens.json for the verify step.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const B = process.env.BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";

// Local creation code (init code) of BallastToken, from the pinned compiler.
const local = execSync("forge inspect src/BallastToken.sol:BallastToken bytecode", {
  encoding: "utf8",
}).trim();
const localHex = local.startsWith("0x") ? local.slice(2) : local;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const TOKENS = JSON.parse(process.env.TOKENS_JSON);

const out = [];
for (const e of TOKENS) {
  const sc = await getJson(`${B}/api/v2/smart-contracts/${e.token}`);
  const chain = (sc.creation_bytecode || "").replace(/^0x/, "");
  if (!chain) {
    console.error(`!! ${e.symbol} ${e.token}: no creation_bytecode`);
    continue;
  }
  const prefixMatch = chain.slice(0, localHex.length) === localHex;
  const args = chain.slice(localHex.length);
  out.push({ ...e, prefixMatch, argsLen: args.length, args });
  console.log(
    `${e.symbol.padEnd(8)} ${e.token}  prefixMatch=${prefixMatch}  argsBytes=${args.length / 2}`
  );
}

writeFileSync("script/verify/tokens.json", JSON.stringify(out, null, 2));
console.log(`\nlocal creationCode bytes: ${localHex.length / 2}`);
console.log("wrote script/verify/tokens.json");
