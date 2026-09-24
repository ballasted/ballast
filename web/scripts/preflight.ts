/**
 * preflight.ts — everything must pass before ANY mainnet broadcast tonight.
 *
 * Checks env vars, RPC reachability, the deployer address + balance, that the
 * contract artifacts deployMainnet.ts needs actually exist, and that every
 * REUSE_* address you're about to point the new factory at is a real deployed
 * contract, not a typo. Exits non-zero and prints exactly what's missing —
 * never guesses, never proceeds partially.
 *
 * Run (from web/):
 *   npx tsx scripts/preflight.ts
 *
 * Env (auto-loaded from ../.env.local then ../../.env; existing process.env wins,
 * same loader as deployMainnet.ts/setAssets.ts):
 *   DEPLOYER_PRIVATE_KEY, PROTOCOL_OWNER_ADDRESS, PROTOCOL_VAULT_ADDRESS
 *   REUSE_ASSET_REGISTRY, REUSE_BACKING_LENS, REUSE_FEE_CONFIG
 *   RH_RPC_URL_PAID (or RPC_UPSTREAM_URL / RH_MAINNET_RPC_URL)
 *   MIN_DEPLOYER_ETH   optional, default 0.01 (see docs/RUNBOOK.md's ETH budget)
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, defineChain, formatEther, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(resolve(__dirname, "../.env.local"));
loadEnv(resolve(__dirname, "../../.env"));

const problems: string[] = [];
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const bad = (msg: string) => { console.log(`  FAIL ${msg}`); problems.push(msg); };

function reqAddr(v: string | undefined): Address | undefined {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}

async function main() {
  console.log("=== Preflight: everything below must pass before ANY broadcast ===\n");

  console.log("[1/6] Required env vars");
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (pk && /^(0x)?[0-9a-fA-F]{64}$/.test(pk)) ok("DEPLOYER_PRIVATE_KEY set (64 hex chars)");
  else bad("DEPLOYER_PRIVATE_KEY missing or malformed — export it before running this");

  const owner = reqAddr(process.env.PROTOCOL_OWNER_ADDRESS);
  owner ? ok(`PROTOCOL_OWNER_ADDRESS = ${owner}`) : bad("PROTOCOL_OWNER_ADDRESS missing/invalid");

  const vault = reqAddr(process.env.PROTOCOL_VAULT_ADDRESS);
  vault ? ok(`PROTOCOL_VAULT_ADDRESS = ${vault}`) : bad("PROTOCOL_VAULT_ADDRESS missing/invalid");

  const reuseRegistry = reqAddr(process.env.REUSE_ASSET_REGISTRY);
  reuseRegistry ? ok(`REUSE_ASSET_REGISTRY = ${reuseRegistry}`) : bad("REUSE_ASSET_REGISTRY missing/invalid — without it deployMainnet.ts deploys a BRAND NEW EMPTY registry, losing the live 10-asset allowlist");

  const reuseLens = reqAddr(process.env.REUSE_BACKING_LENS);
  reuseLens ? ok(`REUSE_BACKING_LENS = ${reuseLens}`) : bad("REUSE_BACKING_LENS missing/invalid");

  const reuseFeeConfig = reqAddr(process.env.REUSE_FEE_CONFIG);
  reuseFeeConfig ? ok(`REUSE_FEE_CONFIG = ${reuseFeeConfig}`) : bad("REUSE_FEE_CONFIG missing/invalid — without it you get a FRESH fee split, losing the live configured one");

  const rpc = process.env.RH_RPC_URL_PAID || process.env.RPC_UPSTREAM_URL || process.env.RH_MAINNET_RPC_URL;
  rpc ? ok(`RPC = ${rpc.replace(/\/v2\/.*$/, "/v2/****")}`) : bad("No RPC URL set (RH_RPC_URL_PAID / RPC_UPSTREAM_URL / RH_MAINNET_RPC_URL)");

  console.log("\n[2/6] Compiled contract artifacts (contracts/out/*)");
  const ARTIFACTS_NEEDED = ["AssetRegistry", "BackingLens", "FeeConfig", "BallastHook", "BallastSeeder", "BallastFactory"];
  const outDir = resolve(__dirname, "../../contracts/out");
  for (const name of ARTIFACTS_NEEDED) {
    const p = resolve(outDir, `${name}.sol/${name}.json`);
    if (existsSync(p)) ok(`${name}.json present`);
    else bad(`${p} missing — run \`cd contracts && forge build\` first`);
  }

  if (!rpc) {
    console.log("\nAborting remaining checks — no RPC to reach.");
    report(problems);
    return;
  }

  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = createPublicClient({ chain, transport: http(rpc) });

  console.log("\n[3/6] RPC answers, correct chain");
  try {
    const id = await client.getChainId();
    if (id === 4663) ok(`eth_chainId = 4663`);
    else bad(`eth_chainId returned ${id}, expected 4663 — wrong RPC endpoint`);
  } catch (e) {
    bad(`RPC did not respond: ${e instanceof Error ? e.message : e}`);
  }

  console.log("\n[4/6] Deployer address + balance");
  if (pk && /^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
    console.log(`  Deployer address: ${account.address}`);
    console.log(`  >>> CONFIRM this is the wallet you intend to fund and deploy from. <<<`);
    const expected = reqAddr(process.env.EXPECTED_DEPLOYER_ADDRESS);
    if (expected) {
      if (expected.toLowerCase() === account.address.toLowerCase()) ok("matches EXPECTED_DEPLOYER_ADDRESS");
      else bad(`derived address ${account.address} != EXPECTED_DEPLOYER_ADDRESS ${expected}`);
    }
    try {
      const bal = await client.getBalance({ address: account.address });
      const min = process.env.MIN_DEPLOYER_ETH ? parseEther(process.env.MIN_DEPLOYER_ETH) : parseEther("0.01");
      console.log(`  Balance: ${formatEther(bal)} ETH (minimum required: ${formatEther(min)} ETH)`);
      if (bal >= min) ok("balance sufficient");
      else bad(`balance ${formatEther(bal)} ETH is below the ${formatEther(min)} ETH minimum — fund the wallet first`);
    } catch (e) {
      bad(`could not read balance: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    console.log("  (skipped — no valid DEPLOYER_PRIVATE_KEY)");
  }

  console.log("\n[5/6] REUSE_* addresses are real deployed contracts");
  for (const [name, addr] of [
    ["REUSE_ASSET_REGISTRY", reuseRegistry],
    ["REUSE_BACKING_LENS", reuseLens],
    ["REUSE_FEE_CONFIG", reuseFeeConfig],
  ] as const) {
    if (!addr) continue;
    try {
      const code = await client.getCode({ address: addr });
      if (code && code !== "0x") ok(`${name} (${addr}) has code`);
      else bad(`${name} (${addr}) has NO code — not a real deployed contract`);
    } catch (e) {
      bad(`${name}: could not read code — ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log("\n[6/6] Live AssetRegistry sanity (won't touch it, just confirms it's the right one)");
  if (reuseRegistry) {
    try {
      const count = (await client.readContract({
        address: reuseRegistry,
        abi: [{ type: "function", name: "allowedAssets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] }],
        functionName: "allowedAssets",
      })) as Address[];
      console.log(`  allowedAssets() returns ${count.length} assets`);
      if (count.length === 10) ok("10 assets live (batch-1) — matches expected pre-runbook state");
      else console.log(`  NOTE: expected 10 (batch-1 only) before step 3 runs — got ${count.length}. Not necessarily wrong, just confirm you know why.`);
    } catch (e) {
      bad(`could not read allowedAssets() on REUSE_ASSET_REGISTRY: ${e instanceof Error ? e.message : e}`);
    }
  }

  report(problems);
}

function report(problems: string[]) {
  console.log("\n" + "=".repeat(60));
  if (problems.length === 0) {
    console.log("ALL CHECKS PASSED. Safe to proceed to the dry run.");
    process.exit(0);
  } else {
    console.log(`${problems.length} PROBLEM(S) — fix before running anything with --broadcast:`);
    problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
