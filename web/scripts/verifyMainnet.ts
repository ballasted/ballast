/**
 * verifyMainnet.ts — verify the deployed BALLAST core on Blockscout WITHOUT forge.
 *
 * The viem deploy has no verify step, so freshly-deployed contracts show only
 * bytecode — unacceptable for a "verify it yourself" product. This reconstructs the
 * solc Standard JSON Input from each Foundry artifact's embedded metadata + on-disk
 * sources and submits it to Blockscout's standard-input API; constructor args are
 * auto-detected from the creation tx. Idempotent: already-verified contracts (incl.
 * Blockscout bytecode-twin auto-matches) are skipped.
 *
 * Run (from web/):
 *   npx tsx scripts/verifyMainnet.ts             # verify every unverified core contract
 *   npx tsx scripts/verifyMainnet.ts --print     # ALSO print forge verify-contract fallbacks
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { encodeAbiParameters, type Address } from "viem";
import { verifyContracts, buildStandardJson, DEFAULT_BLOCKSCOUT, type VerifyTarget } from "./lib/verify";

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

const BLOCKSCOUT = process.env.NEXT_PUBLIC_BLOCKSCOUT_URL ?? DEFAULT_BLOCKSCOUT;
const A = (v: string | undefined): Address | undefined => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);

// name → deployed address (env), plus ctor types/args for the forge fallback print.
const ALL: { name: string; address?: Address; ctorTypes: string[]; ctorArgs: () => unknown[] }[] = [
  { name: "AssetRegistry", address: A(process.env.NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS), ctorTypes: ["address"], ctorArgs: () => [reqEnv("PROTOCOL_OWNER_ADDRESS")] },
  { name: "BackingLens", address: A(process.env.NEXT_PUBLIC_LENS_ADDRESS), ctorTypes: ["address"], ctorArgs: () => [process.env.SEQUENCER_UPTIME_FEED_ADDRESS ?? "0x0000000000000000000000000000000000000000"] },
  { name: "FeeConfig", address: A(process.env.NEXT_PUBLIC_FEE_CONFIG_ADDRESS), ctorTypes: ["address", "address"], ctorArgs: () => [reqEnv("PROTOCOL_OWNER_ADDRESS"), reqEnv("PROTOCOL_VAULT_ADDRESS")] },
  { name: "BallastHook", address: A(process.env.NEXT_PUBLIC_V4_HOOK_ADDRESS), ctorTypes: ["address", "address", "address"], ctorArgs: () => [reqEnv("NEXT_PUBLIC_POOL_MANAGER_ADDRESS"), reqEnv("NEXT_PUBLIC_FEE_CONFIG_ADDRESS"), reqEnv("NEXT_PUBLIC_WETH_ADDRESS")] },
  { name: "BallastSeeder", address: A(process.env.NEXT_PUBLIC_SEEDER_ADDRESS), ctorTypes: ["address", "address", "address"], ctorArgs: () => [reqEnv("NEXT_PUBLIC_POOL_MANAGER_ADDRESS"), reqEnv("NEXT_PUBLIC_WETH_ADDRESS"), reqEnv("NEXT_PUBLIC_V4_HOOK_ADDRESS")] },
  { name: "BallastFactory", address: A(process.env.NEXT_PUBLIC_FACTORY_ADDRESS), ctorTypes: ["address", "address", "address", "address", "uint256", "uint256"], ctorArgs: () => [reqEnv("NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS"), reqEnv("NEXT_PUBLIC_WETH_ADDRESS"), reqEnv("NEXT_PUBLIC_SEEDER_ADDRESS"), reqEnv("NEXT_PUBLIC_ETH_USD_FEED_ADDRESS"), BigInt(process.env.ETH_USD_STALE_WINDOW ?? String(24 * 60 * 60)), BigInt(process.env.UNBACKED_OPEN_FDV_WETH ?? String(5n * 10n ** 18n))] },
];

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`env ${k} required to encode ctor args`);
  return v;
}

async function main() {
  console.log("=== verifyMainnet (Blockscout standard-input) ===");
  console.log("explorer:", BLOCKSCOUT, "\n");

  const targets: VerifyTarget[] = ALL.filter((t): t is typeof t & { address: Address } => Boolean(t.address)).map((t) => ({ name: t.name, address: t.address! }));
  for (const t of ALL) if (!t.address) console.log(`${t.name.padEnd(15)} — address unset in env, skipping`);
  await verifyContracts(targets, { blockscout: BLOCKSCOUT });

  if (process.argv.includes("--print")) {
    console.log("\n── forge verify-contract fallback (needs forge; args pre-encoded) ──");
    for (const t of ALL) {
      if (!t.address) continue;
      const { compiler, target } = buildStandardJson(t.name);
      let ctor = "";
      try {
        ctor = ` \\\n  --constructor-args ${encodeAbiParameters(t.ctorTypes.map((type) => ({ type })), t.ctorArgs())}`;
      } catch (e) { ctor = `   # set env to encode ctor args: ${e instanceof Error ? e.message : e}`; }
      console.log(`forge verify-contract ${t.address} ${target} \\\n  --verifier blockscout --verifier-url ${BLOCKSCOUT}/api --chain-id 4663 \\\n  --compiler-version ${compiler}${ctor}\n`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
