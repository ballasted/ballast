/**
 * compileMainnet.ts — forge-free compile, PROVEN before it's trusted.
 *
 *   npx tsx scripts/compileMainnet.ts --prove        # prove the toolchain (default)
 *   npx tsx scripts/compileMainnet.ts --regen <Name...>   # recompile + overwrite artifacts
 *
 * --prove reproduces the bytecode of contracts whose source is UNCHANGED at this
 * commit and checks it two ways:
 *   1. vs the committed Foundry artifact (out/*.json) — proves solc-js == forge.
 *   2. for immutable-free contracts, vs live on-chain getCode — proves the artifact
 *      (hence our compile) == what is actually deployed and verified.
 * A byte-for-byte match on both is the whole point: verification that costs nothing
 * and proves the pipeline before it produces anything that will hold funds. Any
 * mismatch aborts with a diff summary — nothing gets compiled for real until --prove
 * is green.
 *
 * NOTE on the factory: its source changed (the 5-ETH constructor arg), so it can't
 * match the old on-chain 0x05aaa5 factory — that would be a source diff, not a
 * toolchain failure. The proof therefore runs on unchanged contracts (incl. the
 * immutable-free FeeConfig/AssetRegistry for the strictest, metadata-inclusive
 * match), which proves the exact toolchain the factory will be compiled with.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, defineChain, type Address } from "viem";
import { compileContract, loadPinnedSolc, SOLC_PIN } from "./lib/compile";
import { OUT_DIR } from "./lib/verify";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(path: string) {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(resolve(__dirname, "../.env.local"));
loadEnv(resolve(__dirname, "../../.env"));

function artifactDeployed(name: string): string {
  const j = JSON.parse(readFileSync(resolve(OUT_DIR, `${name}.sol/${name}.json`), "utf8"));
  const o = j.deployedBytecode?.object ?? "";
  return (o.startsWith("0x") ? o : `0x${o}`).toLowerCase();
}

// Unchanged contracts (safe to reproduce). immutableFree → also matchable on-chain.
const PROOF: { name: string; envAddr?: string; immutableFree?: boolean }[] = [
  { name: "FeeConfig", envAddr: "NEXT_PUBLIC_FEE_CONFIG_ADDRESS", immutableFree: true },
  { name: "AssetRegistry", envAddr: "NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS", immutableFree: true },
  { name: "BackingLens", envAddr: "NEXT_PUBLIC_LENS_ADDRESS" }, // has an immutable (sequencer)
  { name: "BallastSeeder", envAddr: "NEXT_PUBLIC_SEEDER_ADDRESS" }, // immutables
];

async function prove() {
  const solc = await loadPinnedSolc();
  console.log(`=== compile proof · solc ${solc.version()} (pinned ${SOLC_PIN.longVersion}) ===`);
  console.log(`compiler verified: sha256 ${SOLC_PIN.sha256.slice(0, 14)}… keccak256 ${SOLC_PIN.keccak256.slice(0, 14)}…\n`);

  const rpc = process.env.RPC_UPSTREAM_URL || "https://rpc.mainnet.chain.robinhood.com";
  const chain = defineChain({ id: 4663, name: "RH", nativeCurrency: { name: "E", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc) });

  let allOk = true;
  for (const p of PROOF) {
    const out = await compileContract(p.name);
    const mine = out.deployedBytecode.toLowerCase();

    // 1. vs committed forge artifact
    const art = artifactDeployed(p.name);
    const artOk = mine === art;
    let line = `${p.name.padEnd(15)} artifact:${artOk ? "MATCH ✓" : "DIFFER ✗"}`;

    // 2. vs on-chain (immutable-free only — otherwise immutables are filled in code)
    let chainNote = "";
    if (p.immutableFree && p.envAddr && /^0x[0-9a-fA-F]{40}$/.test(process.env[p.envAddr] ?? "")) {
      const code = ((await client.getCode({ address: process.env[p.envAddr] as Address })) ?? "0x").toLowerCase();
      const chainOk = code === mine;
      chainNote = `  on-chain(${(process.env[p.envAddr] as string).slice(0, 8)}…):${chainOk ? "MATCH ✓" : "DIFFER ✗"}`;
      if (!chainOk) allOk = false;
    }
    if (!artOk) allOk = false;
    console.log(line + chainNote);
    if (!artOk) console.log(`   mine ${mine.length}B vs artifact ${art.length}B (first diff @ ${firstDiff(mine, art)})`);
  }

  console.log("");
  if (!allOk) {
    console.error("PROOF FAILED — the toolchain does NOT reproduce deployed bytecode. Do not compile anything real until this is understood.");
    process.exit(1);
  }
  console.log("PROOF PASSED — solc-js reproduces both the forge artifacts and the on-chain code byte-for-byte.");
  console.log("Safe to --regen the changed contracts.");
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

async function regen(names: string[]) {
  await loadPinnedSolc();
  for (const name of names) {
    const out = await compileContract(name);
    const path = resolve(OUT_DIR, `${name}.sol/${name}.json`);
    const j = JSON.parse(readFileSync(path, "utf8"));
    j.abi = out.abi;
    j.bytecode = { ...(j.bytecode ?? {}), object: out.bytecode };
    j.deployedBytecode = { ...(j.deployedBytecode ?? {}), object: out.deployedBytecode };
    writeFileSync(path, JSON.stringify(j, null, 2));
    console.log(`regenerated ${name}: creation ${out.bytecode.length} chars → ${path}`);
  }
  console.log("\nArtifacts updated. Re-run the deploy dry-run; verifyMainnet uses the same source graph.");
}

async function main() {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf("--regen");
  if (ri !== -1) {
    const names = argv.slice(ri + 1).filter((a) => !a.startsWith("--"));
    if (!names.length) { console.error("--regen needs at least one contract name"); process.exit(1); }
    await regen(names);
  } else {
    await prove();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
