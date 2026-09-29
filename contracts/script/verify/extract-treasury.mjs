// Extract ProjectTreasury constructor args from on-chain creation bytecode
// (Blockscout) by subtracting the locally compiled creation code. Writes
// treasuries.json for the verify step. Spaced fetches to respect rate limits.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const B = "https://robinhoodchain.blockscout.com";
const local = execSync(
  "forge inspect src/ProjectTreasury.sol:ProjectTreasury bytecode",
  { encoding: "utf8" }
).trim();
const localHex = local.replace(/^0x/, "");

// token -> treasury (from status.mjs output).
const MAP = [
  ["0x0774066659fe4af0fb3757da4da43e51f224333c", "0x0dd54346a97df7d2700542b5584e9cc9cceb75cd", "RCN"],
  ["0x088379c481bef820acea7668c9910ff6d06e3177", "0xd7d628a8c16eb2e80b025b7cfe415a19bb6d94af", "CHRS"],
  ["0x069a260370c61d91bd3e9842d81d378f9750f7f3", "0x4e2037b6fb622e681ce05e4e48c548ea915b4e59", "BALLAST"],
  ["0x016a61ab5899967e4a5f101f6c5227441efcbec6", "0x0259a212f98c51beb5e30463383f1fdab2b29837", "MANATE"],
  ["0x0b5d000bac84bb49d541e5a68a2dc0f6b47ea16f", "0x1203bddc44da1f136b622c5efc7ba78a1e3004bd", "CLAP"],
  ["0x010b1525757229ee340e0ad42d8cb263b4fa963b", "0xae51f7fda747273f4d2f5a1e9069d8d164282387", "BILLIST"],
  ["0x0af65d3c291da6ef80fd4c49ba01ba9492f77c29", "0xe62d6354234ad9e4093707206340ffe653e470c4", "SYNTH"],
  ["0x0107442a5eceda6b3a108e0d55368deb91b18ee6", "0xe6d21c979f10cec8b1d43587e81c5fb006446d4d", "PHIL"],
];
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const out = [];
for (const [token, treasury, sym] of MAP) {
  let sc;
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${B}/api/v2/smart-contracts/${treasury}`, {
        headers: { accept: "application/json" },
      });
      if (r.ok) { sc = await r.json(); break; }
    } catch (e) {
      console.error(`   ${sym} fetch err (try ${a}): ${e.message}`);
    }
    await sleep(8000);
  }
  const chain = (sc?.creation_bytecode || "").replace(/^0x/, "");
  const prefixMatch = chain.slice(0, localHex.length) === localHex;
  const args = chain.slice(localHex.length);
  out.push({ sym, token, treasury, prefixMatch, argsBytes: args.length / 2, args });
  console.log(`${sym.padEnd(8)} ${treasury} prefixMatch=${prefixMatch} argsBytes=${args.length / 2}`);
  await sleep(2500);
}
writeFileSync("script/verify/treasuries.json", JSON.stringify(out, null, 2));
console.log(`local ProjectTreasury creationCode bytes: ${localHex.length / 2}`);
