/**
 * inspectMainnet.ts — read-only post-redeploy audit (chain 4663). Writes nothing.
 *
 * Answers three questions after the factory/hook/feeconfig redeploy:
 *   1. Are the new contracts verified on Blockscout? (GET the v2 smart-contract API.)
 *   2. What WETH fees are stranded on the OLD hook, and owed to whom? (owed() +
 *      WETH.balanceOf across both hooks, per creator + platform vault.)
 *   3. Is the new FeeConfig split actually 50/35/15 @ 1%, and who owns it? Does the
 *      referrer allowlist need re-populating vs the old one?
 *
 * Run (from web/):  npx tsx scripts/inspectMainnet.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, defineChain, formatUnits, parseAbiItem, keccak256, toHex, type Address } from "viem";

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

const A = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

// NEW (from env) + OLD (defaults; overridable). Registry was REUSED (already verified).
const NEW = {
  factory: A(process.env.NEXT_PUBLIC_FACTORY_ADDRESS)!,
  lens: A(process.env.NEXT_PUBLIC_LENS_ADDRESS)!,
  registry: A(process.env.NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS)!,
  hook: A(process.env.NEXT_PUBLIC_V4_HOOK_ADDRESS)!,
  feeConfig: A(process.env.NEXT_PUBLIC_FEE_CONFIG_ADDRESS)!,
  seeder: A(process.env.NEXT_PUBLIC_SEEDER_ADDRESS)!,
};
const OLD = {
  factory: A(process.env.PRIOR_FACTORY ?? "0x069974136c78cf0f2162463b95321e59f56523d8")!,
  hook: A(process.env.PRIOR_HOOK ?? "0x9C15c992E4De3711715C8B7D717EF46e474680CC")!,
  feeConfig: A(process.env.PRIOR_FEE_CONFIG ?? "0xf814ca06affabd1aa5cd31adb5f25d23e9871304")!,
};
const WETH = A(process.env.NEXT_PUBLIC_WETH_ADDRESS)!;
const BLOCKSCOUT = process.env.NEXT_PUBLIC_BLOCKSCOUT_URL ?? "https://robinhoodchain.blockscout.com";

const feeConfigAbi = [
  { type: "function", name: "feeParams", stateMutability: "view", inputs: [], outputs: [
    { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const hookAbi = [
  { type: "function", name: "owed", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feeConfig", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const factoryAbi = [
  { type: "function", name: "launchCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "launches", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { type: "address" }, { type: "address" }, { type: "address" }] },
] as const;

async function main() {
  const rpc = process.env.RPC_UPSTREAM_URL || process.env.RH_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const c = createPublicClient({ chain, transport: http(rpc) });
  const weth = (v: bigint) => `${Number(formatUnits(v, 18)).toLocaleString("en", { maximumFractionDigits: 8 })} WETH`;

  console.log("=== inspectMainnet (read-only) ===");
  console.log("rpc:", rpc.replace(/\/v2\/.*$/, "/v2/****"), "\n");

  // ── 1. FeeConfig split + owner (NEW vs OLD) ──
  console.log("── FeeConfig ──");
  for (const [label, addr] of [["NEW", NEW.feeConfig], ["OLD", OLD.feeConfig]] as const) {
    try {
      const [fp, owner] = await Promise.all([
        c.readContract({ address: addr, abi: feeConfigAbi, functionName: "feeParams" }),
        c.readContract({ address: addr, abi: feeConfigAbi, functionName: "owner" }),
      ]);
      const [feeBps, creatorBps, platformBps, referrerBps, vault] = fp as unknown as [number, number, number, number, Address];
      console.log(`${label} ${addr}`);
      console.log(`   fee=${feeBps}bps (${feeBps / 100}%)  split creator/platform/referrer = ${creatorBps}/${platformBps}/${referrerBps} bps (${creatorBps/100}/${platformBps/100}/${referrerBps/100}%)  sum=${creatorBps+platformBps+referrerBps}`);
      console.log(`   owner=${owner}  platformVault=${vault}`);
    } catch (e) { console.log(`${label} ${addr}: read failed — ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
  }
  // Hook → which FeeConfig each points at (sanity: new hook must read new config).
  for (const [label, addr] of [["NEW", NEW.hook], ["OLD", OLD.hook]] as const) {
    try {
      const fc = await c.readContract({ address: addr, abi: hookAbi, functionName: "feeConfig" });
      console.log(`${label} hook ${addr} -> feeConfig ${fc}`);
    } catch (e) { console.log(`${label} hook feeConfig read failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
  }

  // ── 2. Stranded fees: WETH balance of each hook + owed() per recipient ──
  console.log("\n── Stranded fees (WETH) ──");
  const [oldBal, newBal] = await Promise.all([
    c.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [OLD.hook] }),
    c.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [NEW.hook] }),
  ]);
  console.log(`OLD hook ${OLD.hook} WETH balance: ${weth(oldBal as bigint)}`);
  console.log(`NEW hook ${NEW.hook} WETH balance: ${weth(newBal as bigint)}`);

  // Enumerate launches across BOTH factories to collect creators + platform vault.
  const recipients = new Map<string, string>(); // addr -> label
  const fpNew = (await c.readContract({ address: NEW.feeConfig, abi: feeConfigAbi, functionName: "feeParams" })) as unknown as [number, number, number, number, Address];
  const vaultNew = fpNew[4];
  recipients.set(vaultNew.toLowerCase(), "platformVault");
  for (const [flabel, faddr] of [["new", NEW.factory], ["old", OLD.factory]] as const) {
    let count = 0n;
    try { count = (await c.readContract({ address: faddr, abi: factoryAbi, functionName: "launchCount" })) as bigint; } catch { continue; }
    for (let i = 0n; i < count; i++) {
      try {
        const [token, , creator] = (await c.readContract({ address: faddr, abi: factoryAbi, functionName: "launches", args: [i] })) as unknown as [Address, Address, Address];
        let sym = "?"; try { sym = (await c.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })) as string; } catch {}
        recipients.set(creator.toLowerCase(), `creator of ${sym} (${flabel} factory)`);
      } catch {}
    }
  }

  console.log("\nowed() per recipient  [OLD hook | NEW hook]:");
  for (const [addr, label] of recipients) {
    const [o, n] = await Promise.all([
      c.readContract({ address: OLD.hook, abi: hookAbi, functionName: "owed", args: [addr as Address] }),
      c.readContract({ address: NEW.hook, abi: hookAbi, functionName: "owed", args: [addr as Address] }),
    ]);
    const ob = o as bigint, nb = n as bigint;
    if (ob === 0n && nb === 0n) continue;
    console.log(`   ${addr}  ${label}\n      OLD ${weth(ob)}   |   NEW ${weth(nb)}`);
  }

  // ── 2b. Referrer allowlist on the OLD FeeConfig (mapping can't be enumerated,
  //        so scan ReferrerSet events, then read current isReferrer state). Any
  //        still-allowlisted referrer must be re-added on the NEW FeeConfig. ──
  console.log("\n── Referrer allowlist (OLD FeeConfig) ──");
  try {
    // Use the public RPC for the log scan — the keyed upstream rejected a wide range.
    const pub = createPublicClient({ chain, transport: http("https://rpc.mainnet.chain.robinhood.com") });
    const logs = await pub.getLogs({
      address: OLD.feeConfig,
      event: parseAbiItem("event ReferrerSet(address indexed referrer, bool allowed)"),
      fromBlock: 0n,
      toBlock: "latest",
    });
    const seen = new Set<string>();
    for (const l of logs) seen.add((l.args.referrer as Address).toLowerCase());
    if (seen.size === 0) {
      console.log("   no ReferrerSet events ever — allowlist empty on OLD; nothing to migrate.");
    } else {
      const isReferrerAbi = [{ type: "function", name: "isReferrer", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] }] as const;
      for (const addr of seen) {
        const active = await c.readContract({ address: OLD.feeConfig, abi: isReferrerAbi, functionName: "isReferrer", args: [addr as Address] });
        console.log(`   ${addr}  currently allowlisted on OLD: ${active}${active ? "  ⚠ RE-ADD on NEW FeeConfig" : ""}`);
      }
    }
  } catch {
    // RPC won't serve a wide log range — fall back to Blockscout's indexed logs API.
    try {
      const topic0 = keccak256(toHex("ReferrerSet(address,bool)"));
      const r = await fetch(`${BLOCKSCOUT}/api/v2/addresses/${OLD.feeConfig}/logs`);
      const j: any = await r.json();
      const items: any[] = Array.isArray(j?.items) ? j.items : [];
      const hits = items.filter((it) => (it?.topics ?? [])[0]?.toLowerCase() === topic0.toLowerCase());
      if (hits.length === 0) {
        console.log("   no ReferrerSet events found (Blockscout) — OLD allowlist empty; nothing to migrate.");
      } else {
        console.log(`   ${hits.length} ReferrerSet event(s) on OLD — inspect and re-add any still-active on NEW FeeConfig:`);
        for (const h of hits) console.log(`     ${JSON.stringify(h.decoded ?? h.topics)}`);
      }
    } catch (e2) {
      console.log(`   referrer scan inconclusive (RPC + Blockscout both failed: ${e2 instanceof Error ? e2.message.split("\n")[0] : e2}).`);
      console.log("   NEW allowlist is empty by construction; re-add manually only if you registered a referrer.");
    }
  }

  // ── 3. Blockscout verification status of the six ──
  console.log("\n── Blockscout verification (is_verified) ──");
  const six: [string, Address][] = [
    ["AssetRegistry (REUSED)", NEW.registry], ["BackingLens", NEW.lens], ["FeeConfig", NEW.feeConfig],
    ["BallastHook", NEW.hook], ["BallastSeeder", NEW.seeder], ["BallastFactory", NEW.factory],
  ];
  for (const [name, addr] of six) {
    try {
      const r = await fetch(`${BLOCKSCOUT}/api/v2/smart-contracts/${addr}`);
      if (r.status === 404) { console.log(`   ${name.padEnd(24)} ${addr}  NOT VERIFIED (404 — no source)`); continue; }
      const j: any = await r.json();
      const verified = j?.is_verified === true;
      console.log(`   ${name.padEnd(24)} ${addr}  ${verified ? "VERIFIED" : "NOT verified"}${j?.language ? ` (${j.language} ${j?.compiler_version ?? ""})` : ""}`);
    } catch (e) { console.log(`   ${name.padEnd(24)} ${addr}  status check failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
