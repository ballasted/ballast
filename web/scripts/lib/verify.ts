/**
 * Shared Blockscout verification for the no-forge deploy path. Reconstructs the solc
 * Standard JSON Input from each Foundry artifact's embedded `metadata` (exact
 * compiler version, optimizer runs, evmVersion, bytecodeHash, remappings, source
 * list) plus the on-disk sources, and submits it to Blockscout's standard-input API.
 * Constructor args are auto-detected by Blockscout from the creation tx.
 *
 * Used by both verifyMainnet.ts (standalone) and deployMainnet.ts (post-broadcast).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Address } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_DIR = resolve(__dirname, "../../../contracts");
export const OUT_DIR = resolve(CONTRACTS_DIR, "out");
export const DEFAULT_BLOCKSCOUT = "https://robinhoodchain.blockscout.com";

export type VerifyTarget = { name: string; address: Address };

export function buildStandardJson(name: string): { input: unknown; compiler: string; target: string } {
  const art = JSON.parse(readFileSync(resolve(OUT_DIR, `${name}.sol/${name}.json`), "utf8"));
  const m = art.metadata;
  if (!m?.settings || !m?.sources) throw new Error(`${name}: artifact has no embedded metadata (run forge build once and commit contracts/out)`);
  const sources: Record<string, { content: string }> = {};
  for (const path of Object.keys(m.sources)) {
    sources[path] = { content: readFileSync(resolve(CONTRACTS_DIR, path), "utf8") };
  }
  const s = m.settings;
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: s.optimizer,
      evmVersion: s.evmVersion,
      remappings: s.remappings ?? [],
      metadata: s.metadata ?? { bytecodeHash: "ipfs" },
      libraries: s.libraries ?? {},
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"], "": ["ast"] } },
    },
  };
  const [path, contract] = Object.entries(m.settings.compilationTarget)[0] as [string, string];
  return { input, compiler: `v${m.compiler.version}`, target: `${path}:${contract}` };
}

export async function isVerified(blockscout: string, address: Address): Promise<boolean> {
  try {
    const r = await fetch(`${blockscout}/api/v2/smart-contracts/${address}`);
    if (!r.ok) return false;
    const j: any = await r.json();
    return j?.is_verified === true;
  } catch {
    return false;
  }
}

async function submitStandardInput(blockscout: string, address: Address, name: string): Promise<string> {
  const { input, compiler, target } = buildStandardJson(name);
  const form = new FormData();
  form.append("compiler_version", compiler);
  form.append("license_type", "none");
  form.append("autodetect_constructor_args", "true");
  form.append("contract_name", target);
  form.append("files[0]", new Blob([JSON.stringify(input)], { type: "application/json" }), `${name}.standard-input.json`);
  const r = await fetch(`${blockscout}/api/v2/smart-contracts/${address}/verification/via/standard-input`, { method: "POST", body: form });
  const text = await r.text();
  return `${r.status} ${text.slice(0, 160).replace(/\s+/g, " ")}`;
}

async function pollVerified(blockscout: string, address: Address, tries = 20, delayMs = 3000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await isVerified(blockscout, address)) return true;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return false;
}

/** Verify each target that isn't already verified. Returns per-target outcome. */
export async function verifyContracts(
  targets: VerifyTarget[],
  opts: { blockscout?: string } = {},
): Promise<{ name: string; address: Address; status: "already" | "verified" | "pending" | "error"; detail?: string }[]> {
  const blockscout = opts.blockscout ?? DEFAULT_BLOCKSCOUT;
  const out: { name: string; address: Address; status: "already" | "verified" | "pending" | "error"; detail?: string }[] = [];
  for (const t of targets) {
    if (await isVerified(blockscout, t.address)) {
      console.log(`${t.name.padEnd(15)} ${t.address}  already VERIFIED ✓`);
      out.push({ ...t, status: "already" });
      continue;
    }
    process.stdout.write(`${t.name.padEnd(15)} ${t.address}  submitting standard-input … `);
    try {
      const res = await submitStandardInput(blockscout, t.address, t.name);
      const ok = await pollVerified(blockscout, t.address);
      console.log(`${res} → ${ok ? "VERIFIED ✓" : "not yet verified"}`);
      out.push({ ...t, status: ok ? "verified" : "pending", detail: res });
    } catch (e) {
      const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.log(`submit failed: ${detail}`);
      out.push({ ...t, status: "error", detail });
    }
  }
  return out;
}
