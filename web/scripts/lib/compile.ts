/**
 * Forge-free Solidity compile, pinned + checksum-verified.
 *
 * Why this exists: the deploy/verify pipeline reads precompiled Foundry artifacts,
 * so a SOURCE change needs a recompile — and forge has blocked this machine three
 * times (SetAssets, deploy, the 5-ETH factory). This removes the dependency: it
 * fetches the EXACT solc build that produced the currently-verified contracts,
 * verifies BOTH its sha256 and keccak256 against pinned constants before loading it
 * (a compiler in the path that produces fund-holding bytecode must not be trusted on
 * the strength of an unverified download), and compiles the same Standard JSON Input
 * used for Blockscout verification — so compile settings match by construction.
 *
 * The pin below is the canonical soliditylang.org release for 0.8.28 (foundry.toml
 * `solc = "0.8.28"`), cross-checked against binaries.soliditylang.org/wasm/list.json.
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { keccak256 } from "viem";
import { buildStandardJson } from "./verify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── PINNED compiler (0.8.28+commit.7893614a) ────────────────────────────────────
// Canonical release for 0.8.28; verified against binaries.soliditylang.org list.json.
// Both hashes are checked; a mismatch aborts before the compiler is ever loaded.
export const SOLC_PIN = {
  longVersion: "0.8.28+commit.7893614a",
  file: "soljson-v0.8.28+commit.7893614a.js",
  url: "https://binaries.soliditylang.org/wasm/soljson-v0.8.28+commit.7893614a.js",
  keccak256: "0x8e01bd0cafb8a8bab060453637101a88e4ab6d41c32645a26eaca541fb169c8e",
  sha256: "0x72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146",
} as const;

const CACHE_DIR = resolve(__dirname, "../.solc-cache");

let _solc: any | undefined;

/** Download (once, cached) + dual-checksum-verify + load the pinned compiler. */
export async function loadPinnedSolc(): Promise<any> {
  if (_solc) return _solc;
  const path = resolve(CACHE_DIR, SOLC_PIN.file);
  let buf: Buffer;
  if (existsSync(path)) {
    buf = readFileSync(path);
  } else {
    const r = await fetch(SOLC_PIN.url);
    if (!r.ok) throw new Error(`solc download failed: HTTP ${r.status} from ${SOLC_PIN.url}`);
    buf = Buffer.from(await r.arrayBuffer());
  }

  // Verify BOTH hashes against the pin, every load — cached or fresh.
  const sha = "0x" + createHash("sha256").update(buf).digest("hex");
  const kec = keccak256(new Uint8Array(buf));
  if (sha.toLowerCase() !== SOLC_PIN.sha256.toLowerCase()) {
    throw new Error(`solc sha256 mismatch:\n  got ${sha}\n  pin ${SOLC_PIN.sha256}\nRefusing to use an unverified compiler.`);
  }
  if (kec.toLowerCase() !== SOLC_PIN.keccak256.toLowerCase()) {
    throw new Error(`solc keccak256 mismatch:\n  got ${kec}\n  pin ${SOLC_PIN.keccak256}\nRefusing to use an unverified compiler.`);
  }
  if (!existsSync(path)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, buf);
  }

  // Inject the VERIFIED compiler into the solc-js wrapper (the wrapper is just glue;
  // the compiler binary is the one we checksum'd).
  const solcWrapper = require("solc");
  const solc = solcWrapper.setupMethods(require(path));
  const reported = solc.version();
  if (!String(reported).startsWith("0.8.28+commit.7893614a")) {
    throw new Error(`loaded solc reports ${reported}, expected ${SOLC_PIN.longVersion}`);
  }
  _solc = solc;
  return solc;
}

export type Compiled = {
  abi: unknown[];
  bytecode: string; // creation, 0x-prefixed
  deployedBytecode: string; // runtime, 0x-prefixed
};

/** Compile one contract via its (verification-identical) Standard JSON Input. */
export async function compileContract(name: string): Promise<Compiled> {
  const solc = await loadPinnedSolc();
  const { input, target } = buildStandardJson(name);
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors: any[] = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(`solc errors compiling ${name}:\n${errors.map((e: any) => e.formattedMessage).join("\n")}`);
  const [path, contract] = target.split(":");
  const c = path && contract ? out.contracts?.[path]?.[contract] : undefined;
  if (!c) throw new Error(`solc produced no output for ${target}`);
  const dep = c.evm.deployedBytecode.object as string;
  const cre = c.evm.bytecode.object as string;
  return {
    abi: c.abi,
    bytecode: cre.startsWith("0x") ? cre : `0x${cre}`,
    deployedBytecode: dep.startsWith("0x") ? dep : `0x${dep}`,
  };
}
