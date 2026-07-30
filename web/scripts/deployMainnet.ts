/**
 * deployMainnet.ts — deploy the full BALLAST core to Robinhood Chain WITHOUT forge.
 *
 * A viem/TypeScript rewrite of contracts/script/DeployMainnet.s.sol, for a machine
 * that has Node + an RPC but no working Foundry (same reason setAssets.ts exists).
 * It deploys the six core contracts in the SAME order, with the SAME constructor
 * arguments, and mines the BallastHook CREATE2 salt the same way HookMiner does so
 * the hook lands on an address whose low 14 bits equal the required Uniswap v4 flags.
 *
 *   1. AssetRegistry(owner)
 *   2. BackingLens(sequencerUptimeFeed)          // 0x0 on chain 4663 → reports Unknown
 *   3. FeeConfig(owner, vault)
 *   4. BallastHook(poolManager, feeConfig, weth) // CREATE2 via the Arachnid proxy,
 *                                                //   salt mined for flags 0xCC
 *   5. BallastSeeder(poolManager, weth, hook)
 *   6. BallastFactory(registry, weth, seeder, ethUsdFeed, ethUsdStaleWindow, unbackedOpenFdvWeth)
 *
 * It reads the COMPILED creation bytecode + ABI straight from Foundry's build output
 * (contracts/out/<C>.sol/<C>.json). If those artifacts are missing you must first
 * compile once (on any machine with forge) and commit contracts/out — this script
 * does not compile Solidity.
 *
 * ETH/USD stale window: the immutable outer freshness bound for the ETH/USD leg at
 * graduation. Default 24h (86400s) — identical to the Solidity default
 * (vm.envOr("ETH_USD_STALE_WINDOW", 24 hours)). CLAUDE.md rules 6/16: this is only
 * the coarse on-chain backstop; the market-hours-aware RESTING-vs-STALE gate lives
 * off-chain and must never revert launches.
 *
 * REUSE (for the freshness-gate factory redeploy): the documented redeploy keeps the
 * SAME AssetRegistry so SGOV stays allowlisted and existing launches keep resolving.
 * Set REUSE_ASSET_REGISTRY (and optionally REUSE_BACKING_LENS / REUSE_FEE_CONFIG) to
 * an existing address to skip deploying that contract and wire the new factory to it.
 * Left unset, all six deploy fresh — exactly like the Solidity script.
 *
 * DRY-RUN by default: mines the hook salt, predicts every address, prints the full
 * plan with every constructor argument, and writes NOTHING. Broadcasts only with
 * --broadcast (or DRY_RUN=false).
 *
 * Env (auto-loaded from ../.env.local then ../../.env; existing process.env wins):
 *   DEPLOYER_PRIVATE_KEY          funded deployer (needed to broadcast; in dry-run,
 *                                 used only to derive the address for nonce prediction)
 *   PROTOCOL_OWNER_ADDRESS        owner of AssetRegistry + FeeConfig (use a multisig)
 *   PROTOCOL_VAULT_ADDRESS        platform fee vault
 *   POOL_MANAGER                  v4 PoolManager  (fallback NEXT_PUBLIC_POOL_MANAGER_ADDRESS)
 *   WETH                          (fallback NEXT_PUBLIC_WETH_ADDRESS)
 *   ETH_USD_FEED                  Chainlink ETH/USD (fallback NEXT_PUBLIC_ETH_USD_FEED_ADDRESS)
 *   ETH_USD_STALE_WINDOW          seconds; default 86400 (24h)
 *   SEQUENCER_UPTIME_FEED_ADDRESS optional; default 0x0 (none on 4663 → Unknown)
 *   REUSE_ASSET_REGISTRY / REUSE_BACKING_LENS / REUSE_FEE_CONFIG   optional, see above
 *   RPC_UPSTREAM_URL / RH_RPC_URL_PAID / RH_MAINNET_RPC_URL        an RPC endpoint
 *
 * After a successful --broadcast it VERIFIES all six on Blockscout (standard-input
 * API — the forge --verify equivalent, no forge needed); pass --no-verify to skip,
 * or run scripts/verifyMainnet.ts later. If the HOOK address changes, also set
 * NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES (see lib/contracts.ts) so prior pools' fees stay
 * claimable and those tokens stay tradeable/priced.
 *
 * Run (from web/):
 *   npx tsx scripts/deployMainnet.ts              # dry-run: print the plan, write nothing
 *   npx tsx scripts/deployMainnet.ts --broadcast  # deploy + verify, as the funded deployer
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  encodeDeployData,
  getContractAddress,
  getCreate2Address,
  keccak256,
  concatHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── env loading (no dotenv dependency; identical to setAssets.ts) ────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // file absent is fine
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

// ── constants ─────────────────────────────────────────────────────────────────
// Arachnid deterministic CREATE2 proxy — the deployer HookMiner assumes (rule: this
// exact address is the CREATE2 `deployer` used to derive the hook address).
const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

// Uniswap v4 hook flags (Hooks.sol). The BallastHook needs its address' bottom 14
// bits to equal exactly these four. Mirrors DeployMainnet._deployHook.
const BEFORE_SWAP_FLAG = 1n << 7n;
const AFTER_SWAP_FLAG = 1n << 6n;
const BEFORE_SWAP_RETURNS_DELTA_FLAG = 1n << 3n;
const AFTER_SWAP_RETURNS_DELTA_FLAG = 1n << 2n;
const HOOK_FLAGS =
  BEFORE_SWAP_FLAG | BEFORE_SWAP_RETURNS_DELTA_FLAG | AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG; // = 0xCC (204)
const FLAG_MASK = (1n << 14n) - 1n; // Hooks.ALL_HOOK_MASK = 0x3FFF
const MAX_MINE_ITERS = 2_000_000; // ~16k expected; generous cap (Solidity uses 160_444)

const DEFAULT_ETH_USD_STALE_WINDOW = 24n * 60n * 60n; // 24h, matching the Solidity default
// Unbacked opening FDV (WETH), matching the Solidity default (5 ether). WETH-pegged;
// the factory derives UNBACKED_TICK from it. 5 ETH ⇒ ~2 ETH of net buying to 2× an
// unbacked token, so a Discover price isn't movable for a few hundred dollars.
const DEFAULT_UNBACKED_OPEN_FDV_WETH = 5n * 10n ** 18n;

const CONTRACTS_OUT = resolve(__dirname, "../../contracts/out");

// ── artifact loading ─────────────────────────────────────────────────────────
type Artifact = { abi: Abi; bytecode: Hex };
function loadArtifact(name: string): Artifact {
  const path = resolve(CONTRACTS_OUT, `${name}.sol/${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Missing artifact ${path}. Compile the contracts once (forge build) and commit contracts/out — this script does not compile Solidity.`,
    );
  }
  const j = JSON.parse(raw);
  const object: string | undefined = j?.bytecode?.object;
  if (!object || object === "0x") throw new Error(`Artifact ${name} has no creation bytecode.`);
  return { abi: j.abi as Abi, bytecode: (object.startsWith("0x") ? object : `0x${object}`) as Hex };
}

// ── helpers ────────────────────────────────────────────────────────────────────
function reqAddr(v: string | undefined): Address | undefined {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}
function must(v: Address | undefined, name: string): Address {
  if (!v) {
    console.error(`ERROR: ${name} is not set/valid (expected a 0x… address).`);
    process.exit(1);
  }
  return v;
}

// Mine a CREATE2 salt so the hook address' bottom 14 bits equal HOOK_FLAGS.
// Pure computation — safe to run in dry-run (writes nothing).
function mineHookSalt(initCode: Hex): { salt: Hex; address: Address; iters: number } {
  const bytecodeHash = keccak256(initCode);
  for (let i = 0; i < MAX_MINE_ITERS; i++) {
    const salt = toHex(BigInt(i), { size: 32 });
    const address = getCreate2Address({ from: CREATE2_DEPLOYER, salt, bytecodeHash });
    if ((BigInt(address) & FLAG_MASK) === HOOK_FLAGS) {
      return { salt, address, iters: i };
    }
  }
  throw new Error(`HookMiner: no salt found in ${MAX_MINE_ITERS} iterations`);
}

async function main() {
  const broadcast = process.argv.includes("--broadcast") || process.env.DRY_RUN === "false";

  // ── resolve env (with the same NEXT_PUBLIC_ fallbacks the frontend uses) ──
  const owner = must(reqAddr(process.env.PROTOCOL_OWNER_ADDRESS), "PROTOCOL_OWNER_ADDRESS");
  const vault = must(reqAddr(process.env.PROTOCOL_VAULT_ADDRESS), "PROTOCOL_VAULT_ADDRESS");
  const pm = must(
    reqAddr(process.env.POOL_MANAGER) ?? reqAddr(process.env.NEXT_PUBLIC_POOL_MANAGER_ADDRESS),
    "POOL_MANAGER",
  );
  const weth = must(reqAddr(process.env.WETH) ?? reqAddr(process.env.NEXT_PUBLIC_WETH_ADDRESS), "WETH");
  const ethUsdFeed = must(
    reqAddr(process.env.ETH_USD_FEED) ?? reqAddr(process.env.NEXT_PUBLIC_ETH_USD_FEED_ADDRESS),
    "ETH_USD_FEED",
  );
  // Optional. Solidity: vm.envOr(..., address(0)). No sequencer feed on 4663.
  const sequencer = reqAddr(process.env.SEQUENCER_UPTIME_FEED_ADDRESS) ?? ("0x0000000000000000000000000000000000000000" as Address);

  const ethUsdStaleWindow = process.env.ETH_USD_STALE_WINDOW
    ? BigInt(process.env.ETH_USD_STALE_WINDOW)
    : DEFAULT_ETH_USD_STALE_WINDOW;
  if (ethUsdStaleWindow === 0n) {
    console.error("ERROR: ETH_USD_STALE_WINDOW must be > 0 (the factory constructor reverts on 0).");
    process.exit(1);
  }
  const unbackedOpenFdvWeth = process.env.UNBACKED_OPEN_FDV_WETH
    ? BigInt(process.env.UNBACKED_OPEN_FDV_WETH)
    : DEFAULT_UNBACKED_OPEN_FDV_WETH;
  if (unbackedOpenFdvWeth === 0n) {
    console.error("ERROR: UNBACKED_OPEN_FDV_WETH must be > 0 (the factory constructor reverts on 0).");
    process.exit(1);
  }

  // Optional reuse (freshness-gate redeploy keeps the SAME registry).
  const reuseRegistry = reqAddr(process.env.REUSE_ASSET_REGISTRY);
  const reuseLens = reqAddr(process.env.REUSE_BACKING_LENS);
  const reuseFeeConfig = reqAddr(process.env.REUSE_FEE_CONFIG);

  const rpc =
    process.env.RPC_UPSTREAM_URL ||
    process.env.RH_RPC_URL_PAID ||
    process.env.RH_MAINNET_RPC_URL ||
    "https://rpc.mainnet.chain.robinhood.com";
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });

  // Deployer: required to broadcast; in dry-run only used to derive the address for
  // nonce-based CREATE address prediction (skipped if absent).
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const account = pk ? privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex) : undefined;

  console.log("=== DeployMainnet (viem): deploy BALLAST core to chain 4663 ===");
  console.log("mode        :", broadcast ? "BROADCAST (will deploy)" : "DRY-RUN (writes nothing)");
  console.log("rpc         :", rpc.replace(/\/v2\/.*$/, "/v2/****"));
  console.log("deployer     :", account ? account.address : "(DEPLOYER_PRIVATE_KEY unset — addresses not predicted)");
  console.log("owner        :", owner);
  console.log("vault        :", vault);
  console.log("poolManager  :", pm);
  console.log("weth         :", weth);
  console.log("ethUsdFeed   :", ethUsdFeed);
  console.log("staleWindow  :", `${ethUsdStaleWindow}s`, ethUsdStaleWindow === DEFAULT_ETH_USD_STALE_WINDOW ? "(default 24h)" : "");
  console.log("unbackedFDV  :", `${Number(unbackedOpenFdvWeth) / 1e18} WETH`, unbackedOpenFdvWeth === DEFAULT_UNBACKED_OPEN_FDV_WETH ? "(default 5 ETH; factory derives the tick)" : "");
  console.log("sequencer    :", sequencer, sequencer === "0x0000000000000000000000000000000000000000" ? "(0x0 → BackingLens reports Unknown; none on 4663)" : "");
  console.log("reuse        :", [
    reuseRegistry ? `registry=${reuseRegistry}` : null,
    reuseLens ? `lens=${reuseLens}` : null,
    reuseFeeConfig ? `feeConfig=${reuseFeeConfig}` : null,
  ].filter(Boolean).join(", ") || "(none — all six deploy fresh)");
  console.log("");

  // ── artifacts ──
  const A = {
    AssetRegistry: loadArtifact("AssetRegistry"),
    BackingLens: loadArtifact("BackingLens"),
    FeeConfig: loadArtifact("FeeConfig"),
    BallastHook: loadArtifact("BallastHook"),
    BallastSeeder: loadArtifact("BallastSeeder"),
    BallastFactory: loadArtifact("BallastFactory"),
  };

  // The hook's init code (and therefore its mined salt/address) embeds the FeeConfig
  // address, so FeeConfig must be resolved before the hook can be mined.
  // Resolve FeeConfig address FIRST if reusing (the hook's init code embeds it, and
  // the mined salt depends on the exact init code). If deploying fresh, we must
  // predict FeeConfig's CREATE address before mining — so we need the nonce.
  let nonce = account ? await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }) : 0;
  const startNonce = nonce;

  // Predicted/actual addresses, filled as we walk the plan in deploy order.
  const addr: Record<string, Address> = {};

  // 1. AssetRegistry
  if (reuseRegistry) {
    addr.AssetRegistry = reuseRegistry;
  } else {
    addr.AssetRegistry = account ? getContractAddress({ from: account.address, nonce: BigInt(nonce++) }) : ("0x?" as Address);
  }
  // 2. BackingLens
  if (reuseLens) {
    addr.BackingLens = reuseLens;
  } else {
    addr.BackingLens = account ? getContractAddress({ from: account.address, nonce: BigInt(nonce++) }) : ("0x?" as Address);
  }
  // 3. FeeConfig
  if (reuseFeeConfig) {
    addr.FeeConfig = reuseFeeConfig;
  } else {
    addr.FeeConfig = account ? getContractAddress({ from: account.address, nonce: BigInt(nonce++) }) : ("0x?" as Address);
  }

  // 4. BallastHook — init code (and therefore mined salt/address) depends on the
  // FeeConfig address. In dry-run without a deployer key we can't predict FeeConfig's
  // CREATE address, so we can't mine a meaningful salt; report and skip mining then.
  const feeConfigKnown = reuseFeeConfig ? true : Boolean(account);
  let hookSalt: Hex | undefined;
  if (feeConfigKnown) {
    const realHookInit = encodeDeployData({
      abi: A.BallastHook.abi,
      bytecode: A.BallastHook.bytecode,
      args: [pm, addr.FeeConfig, weth],
    });
    console.log(`Mining hook salt for flags 0x${HOOK_FLAGS.toString(16)} (mask 0x${FLAG_MASK.toString(16)}) …`);
    const mined = mineHookSalt(realHookInit);
    hookSalt = mined.salt;
    addr.BallastHook = mined.address;
    console.log(`  found after ${mined.iters} iters → hook ${mined.address} (salt ${mined.salt})`);
    console.log("");
  } else {
    addr.BallastHook = ("0x? (needs DEPLOYER_PRIVATE_KEY to predict FeeConfig, then mine)" as Address);
    console.log("Hook salt NOT mined: FeeConfig is deployed fresh and DEPLOYER_PRIVATE_KEY is unset,");
    console.log("so its CREATE address (embedded in the hook init code) can't be predicted. Set the");
    console.log("key or REUSE_FEE_CONFIG to mine in dry-run.\n");
  }
  // The hook deploy is a CALL to the CREATE2 proxy — it still consumes a deployer nonce.
  if (account) nonce++;

  // 5. BallastSeeder(poolManager, weth, hook)
  addr.BallastSeeder = account ? getContractAddress({ from: account.address, nonce: BigInt(nonce++) }) : ("0x?" as Address);
  // 6. BallastFactory(registry, weth, seeder, ethUsdFeed, ethUsdStaleWindow)
  addr.BallastFactory = account ? getContractAddress({ from: account.address, nonce: BigInt(nonce++) }) : ("0x?" as Address);

  // ── print the plan ──
  const plan: Array<{ step: string; action: string; args: unknown[]; predicted: Address }> = [
    { step: "AssetRegistry", action: reuseRegistry ? "REUSE" : "deploy", args: [owner], predicted: addr.AssetRegistry },
    { step: "BackingLens", action: reuseLens ? "REUSE" : "deploy", args: [sequencer], predicted: addr.BackingLens },
    { step: "FeeConfig", action: reuseFeeConfig ? "REUSE" : "deploy", args: [owner, vault], predicted: addr.FeeConfig },
    { step: "BallastHook", action: "deploy (CREATE2)", args: [pm, addr.FeeConfig, weth], predicted: addr.BallastHook },
    { step: "BallastSeeder", action: "deploy", args: [pm, weth, addr.BallastHook], predicted: addr.BallastSeeder },
    {
      step: "BallastFactory",
      action: "deploy",
      args: [addr.AssetRegistry, weth, addr.BallastSeeder, ethUsdFeed, ethUsdStaleWindow.toString(), `${unbackedOpenFdvWeth.toString()} (unbackedOpenFdvWeth)`],
      predicted: addr.BallastFactory,
    },
  ];
  console.log("PLAN (deploy order):");
  for (const p of plan) {
    console.log(`  ${p.step.padEnd(15)} ${p.action.padEnd(16)} -> ${p.predicted}`);
    console.log(`      args: ${JSON.stringify(p.args)}`);
  }
  if (account) console.log(`\n  (CREATE addresses predicted from deployer nonce ${startNonce}; valid only if no other tx from this account interleaves.)`);
  console.log("");

  if (!broadcast) {
    console.log("DRY-RUN: nothing deployed. Re-run with --broadcast (as the funded deployer) to deploy.");
    console.log("After deploying, copy the printed addresses into web/.env.local.");
    return;
  }

  // ── broadcast ──
  if (!account) {
    console.error("ABORT: DEPLOYER_PRIVATE_KEY not set (required to broadcast).");
    process.exit(1);
  }
  if (!hookSalt) {
    console.error("ABORT: hook salt was not mined (see message above).");
    process.exit(1);
  }
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const deployed: Record<string, Address> = {};

  async function deployCreate(name: keyof typeof A, args: unknown[]): Promise<Address> {
    const hash = await wallet.deployContract({ abi: A[name].abi, bytecode: A[name].bytecode, args, account, chain } as never);
    process.stdout.write(`  ${String(name).padEnd(15)} tx ${hash} … `);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      console.log("REVERTED");
      throw new Error(`${name} deploy reverted (${hash}).`);
    }
    console.log(receipt.contractAddress);
    return receipt.contractAddress;
  }

  // 1–3 (or reuse)
  deployed.AssetRegistry = reuseRegistry ?? (await deployCreate("AssetRegistry", [owner]));
  deployed.BackingLens = reuseLens ?? (await deployCreate("BackingLens", [sequencer]));
  deployed.FeeConfig = reuseFeeConfig ?? (await deployCreate("FeeConfig", [owner, vault]));

  // 4. Hook via CREATE2 proxy: calldata = salt(32) ++ initCode. Re-encode init code
  // against the ACTUAL FeeConfig, then re-mine if it differs from the prediction
  // (it won't if the nonce held, but be safe — the salt must match the real init code).
  let hookInit = encodeDeployData({ abi: A.BallastHook.abi, bytecode: A.BallastHook.bytecode, args: [pm, deployed.FeeConfig, weth] });
  let finalSalt = hookSalt;
  let expectedHook = getCreate2Address({ from: CREATE2_DEPLOYER, salt: finalSalt, bytecodeHash: keccak256(hookInit) });
  if ((BigInt(expectedHook) & FLAG_MASK) !== HOOK_FLAGS) {
    console.log("  FeeConfig address differed from prediction — re-mining hook salt against the real init code …");
    const mined = mineHookSalt(hookInit);
    finalSalt = mined.salt;
    expectedHook = mined.address;
  }
  const existing = await publicClient.getCode({ address: expectedHook });
  if (existing && existing !== "0x") {
    throw new Error(`Hook target ${expectedHook} already has code — salt collision; widen the search.`);
  }
  const hookHash = await wallet.sendTransaction({ account, chain, to: CREATE2_DEPLOYER, data: concatHex([finalSalt, hookInit]) });
  process.stdout.write(`  BallastHook     tx ${hookHash} (CREATE2 salt ${finalSalt}) … `);
  const hookReceipt = await publicClient.waitForTransactionReceipt({ hash: hookHash });
  if (hookReceipt.status !== "success") {
    console.log("REVERTED");
    throw new Error(`Hook CREATE2 deploy reverted (${hookHash}).`);
  }
  const hookCode = await publicClient.getCode({ address: expectedHook });
  if (!hookCode || hookCode === "0x") throw new Error(`Hook not deployed at ${expectedHook} after CREATE2.`);
  deployed.BallastHook = expectedHook;
  console.log(expectedHook);

  // 5–6
  deployed.BallastSeeder = await deployCreate("BallastSeeder", [pm, weth, deployed.BallastHook]);
  deployed.BallastFactory = await deployCreate("BallastFactory", [
    deployed.AssetRegistry,
    weth,
    deployed.BallastSeeder,
    ethUsdFeed,
    ethUsdStaleWindow,
    unbackedOpenFdvWeth,
  ]);

  // ── post-deploy sanity (no forge to run tests here, so read the derived values
  // back and assert the known-good tick for the default 5 ETH FDV). This is the
  // acceptance gate for the on-chain tick derivation. ──
  try {
    const [tick, fdv] = await Promise.all([
      publicClient.readContract({
        address: deployed.BallastFactory,
        abi: [{ type: "function", name: "UNBACKED_TICK", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] }] as const,
        functionName: "UNBACKED_TICK",
      }),
      publicClient.readContract({
        address: deployed.BallastFactory,
        abi: [{ type: "function", name: "unbackedOpenFdvWeth", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const,
        functionName: "unbackedOpenFdvWeth",
      }),
    ]);
    console.log(`\nunbacked open: FDV=${Number(fdv) / 1e18} ETH → UNBACKED_TICK=${tick}`);
    if (fdv === 5n * 10n ** 18n && tick !== -191160) {
      console.error(`WARNING: expected UNBACKED_TICK -191160 for 5 ETH FDV, got ${tick}. Do NOT trust this deploy until reconciled.`);
    }
  } catch (e) {
    console.error("post-deploy tick read-back failed:", e instanceof Error ? e.message : e);
  }

  // ── report ── (ready to paste into web/.env.local)
  console.log("\n=== DEPLOYED — copy into web/.env.local ===");
  console.log(`NEXT_PUBLIC_FACTORY_ADDRESS=${deployed.BallastFactory}`);
  console.log(`NEXT_PUBLIC_LENS_ADDRESS=${deployed.BackingLens}`);
  console.log(`NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS=${deployed.AssetRegistry}`);
  console.log(`NEXT_PUBLIC_V4_HOOK_ADDRESS=${deployed.BallastHook}`);
  console.log(`# FeeConfig: ${deployed.FeeConfig}   Seeder: ${deployed.BallastSeeder}`);
  console.log("");
  console.log("PRIOR lists (newest-first). Only include factories/hooks that actually");
  console.log("launched or hold a pool — DROP any empty deploy so the read union stays small:");
  console.log("  NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES = <old factory(ies) that launched tokens>");
  console.log("  NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES     = <old hook(s) with live pools>");
  console.log("  (e.g. keep 0x0699…523d8 / 0x9C15…680CC for $BALLAST+CHRS; drop the empty");
  console.log("   0x05aaa5… factory + 0x7431…080cc hook — they launched/held nothing.)");
  console.log(`sequencer feed (0x0 = Unknown, none on 4663): ${sequencer}`);

  // ── verify on Blockscout (the forge --verify equivalent, via the standard-input
  // API) unless opted out. A "verify it yourself" product must not ship bytecode-only
  // contracts. Constructor args are auto-detected by Blockscout from the creation tx.
  if (process.argv.includes("--no-verify")) {
    console.log("\n--no-verify: skipping Blockscout verification. Run `npx tsx scripts/verifyMainnet.ts` later.");
    return;
  }
  console.log("\n=== Verifying on Blockscout (standard-input) ===");
  try {
    const { verifyContracts } = await import("./lib/verify");
    await verifyContracts(
      [
        { name: "AssetRegistry", address: deployed.AssetRegistry },
        { name: "BackingLens", address: deployed.BackingLens },
        { name: "FeeConfig", address: deployed.FeeConfig },
        { name: "BallastHook", address: deployed.BallastHook },
        { name: "BallastSeeder", address: deployed.BallastSeeder },
        { name: "BallastFactory", address: deployed.BallastFactory },
      ],
      { blockscout: process.env.NEXT_PUBLIC_BLOCKSCOUT_URL },
    );
  } catch (e) {
    console.error("Verification step failed:", e instanceof Error ? e.message : e);
    console.error("Deploy succeeded — re-run `npx tsx scripts/verifyMainnet.ts --print` to retry / get forge fallbacks.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
