// Load env for the Creator Fund scripts WITHOUT any extra dependency. Mirrors the
// pattern in web/scripts/inspectMainnet.ts: read web/.env.local first (Next's own
// env dir), then the repo-root .env, never clobbering a variable already set in the
// process environment (so CI / shell exports win).
//
// Secrets are read BY NAME only and never printed. `requireRpcUrl()` returns the
// paid RPC URL (RH_RPC_URL_PAID) without ever logging it.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // scripts/creator-fund/lib
const repoRoot = resolve(here, "..", "..", ".."); // repo root

function parseAndApply(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Load web/.env.local then repo-root .env into process.env (no clobber). */
export function loadEnv(): void {
  parseAndApply(resolve(repoRoot, "web", ".env.local"));
  parseAndApply(resolve(repoRoot, ".env"));
}

/**
 * The RPC URL, read BY NAME. Preference: RH_RPC_URL_PAID (the campaign brief's named
 * endpoint) → RPC_UPSTREAM_URL (the app's server RPC) → the public RPC. Never
 * returns or logs the value anywhere except into the viem transport.
 */
export function getRpcUrl(): { url: string; sourceName: string } {
  const paid = process.env.RH_RPC_URL_PAID;
  if (paid && paid.length > 0) return { url: paid, sourceName: "RH_RPC_URL_PAID" };
  const upstream = process.env.RPC_UPSTREAM_URL;
  if (upstream && upstream.length > 0) return { url: upstream, sourceName: "RPC_UPSTREAM_URL" };
  return { url: "https://rpc.mainnet.chain.robinhood.com", sourceName: "public RPC (rate-limited)" };
}

export const REPO_ROOT = repoRoot;
