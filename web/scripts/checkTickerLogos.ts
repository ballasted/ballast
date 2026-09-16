/**
 * checkTickerLogos.ts — fail the build if any on-chain-allowlisted reserve
 * asset has no local logo file.
 *
 * Runs automatically as `prebuild` (see package.json), so `npm run build` —
 * what both a local build and Vercel run — fails loudly the moment a newly
 * allowlisted asset (via AssetRegistry.setAsset) has no matching file under
 * public/assets/tickers/. Without this, the next asset added to the
 * allowlist would silently regress to the AssetDisc monogram fallback and
 * nobody would notice until someone happened to look.
 *
 * Env (same auto-load pattern as scripts/setAssets.ts):
 *   NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS (or ASSET_REGISTRY)   deployed registry
 *   RPC_UPSTREAM_URL / RH_RPC_URL_PAID / RH_MAINNET_RPC_URL  an RPC endpoint
 *
 * Unset registry address = nothing deployed yet (e.g. a contributor's local
 * checkout with no .env.local) — skips cleanly, exit 0. A CONFIGURED registry
 * that can't be read (RPC down) is NOT treated the same way: that's exactly
 * the silent-regression risk this script exists to catch, so it fails loud
 * rather than skip quietly. Escape hatch for a genuinely RPC-less local build:
 *   SKIP_TICKER_LOGO_CHECK=1 npm run build
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, defineChain, type Address } from "viem";

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(resolve(__dirname, "../.env.local"));
loadEnv(resolve(__dirname, "../../.env"));

function reqAddr(v: string | undefined): Address | undefined {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}

const ASSET_REGISTRY_ABI = [
  { type: "function", name: "allowedAssets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;
const ERC20_SYMBOL_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const TICKERS_DIR = resolve(__dirname, "../public/assets/tickers");

async function main() {
  if (process.env.SKIP_TICKER_LOGO_CHECK === "1") {
    console.log("checkTickerLogos: SKIP_TICKER_LOGO_CHECK=1 set, skipping.");
    return;
  }

  const registryAddr = reqAddr(process.env.NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS) ?? reqAddr(process.env.ASSET_REGISTRY);
  if (!registryAddr) {
    console.log("checkTickerLogos: no AssetRegistry address configured — skipping (nothing to check yet).");
    return;
  }

  const rpc =
    process.env.RPC_UPSTREAM_URL || process.env.RH_RPC_URL_PAID || process.env.RH_MAINNET_RPC_URL ||
    "https://rpc.mainnet.chain.robinhood.com";

  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = createPublicClient({ chain, transport: http(rpc) });

  console.log("checkTickerLogos: reading AssetRegistry.allowedAssets()...");
  let allowed: readonly Address[];
  try {
    allowed = (await client.readContract({
      address: registryAddr,
      abi: ASSET_REGISTRY_ABI,
      functionName: "allowedAssets",
    })) as readonly Address[];
  } catch (e) {
    console.error("checkTickerLogos: FAILED to read the allowlist — treating this as a build failure rather");
    console.error("than skipping quietly, since a silently-unreachable check is exactly the failure mode this");
    console.error("script exists to prevent. Set SKIP_TICKER_LOGO_CHECK=1 to bypass for a known-RPC-less build.");
    console.error(e);
    process.exit(1);
  }

  if (allowed.length === 0) {
    console.log("checkTickerLogos: allowlist is empty — nothing to check.");
    return;
  }

  const present = new Set(
    readdirSync(TICKERS_DIR).map((f) => f.replace(/\.(png|svg)$/i, "").toUpperCase()),
  );

  const missing: string[] = [];
  for (const asset of allowed) {
    let symbol: string;
    try {
      symbol = (await client.readContract({ address: asset, abi: ERC20_SYMBOL_ABI, functionName: "symbol" })) as string;
    } catch {
      missing.push(`${asset} (couldn't read symbol())`);
      continue;
    }
    const ticker = symbol.toUpperCase();
    if (!present.has(ticker)) missing.push(`${ticker} (${asset})`);
  }

  if (missing.length > 0) {
    console.error("checkTickerLogos: FAILED — allowlisted asset(s) with no logo file in public/assets/tickers/:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("Add the file (see docs/assets-brand/ballast-ticker-logos/ for the source set) and the");
    console.error("scale entry in lib/tickerLogos.ts before this can ship — the monogram fallback must never");
    console.error("be what a user sees for an allowlisted asset.");
    process.exit(1);
  }

  console.log(`checkTickerLogos: OK — all ${allowed.length} allowlisted asset(s) have a local logo file.`);
}

main();
