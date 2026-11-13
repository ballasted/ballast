import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, decodeEventLog, defineChain, encodeAbiParameters, concatHex, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ballastFactoryV5Abi } from "../../lib/abisV5";
import { universalRouterExecuteAbi } from "../../lib/robinhoodRouter";
import { ANVIL_PORT, ANVIL_RPC_URL, BRIDGE_PORT, APP_PORT, APP_URL, FORK_RPC, FIXTURE_PATH } from "./fixture";

const WEB_DIR = path.join(__dirname, "..", "..");
const PIDS_FILE = path.join(__dirname, ".pids.json");

const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FACTORY = "0x24c9582C31a7B890dC51D51e99E1283880Bc4bEE" as Address;
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as Address;
const HOOK = "0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc" as Address;
const UR = "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a" as Address;
const ADDR_THIS = "0x0000000000000000000000000000000000000002" as Address;
const CONTRACT_BALANCE = 1n << 255n;

// Inline fork-encoded (minHopPriceX36) buy — a tiny priming trade so the one-sided
// bootstrap pool has active liquidity at the current tick, making the in-browser
// quote deterministic for either token/WHYPE ordering. Mirrors lib/swap.ts.
function buildPrimingBuy(token: Address, amountIn: bigint): { commands: Hex; inputs: Hex[]; value: bigint } {
  const tokenIs0 = token.toLowerCase() < WHYPE.toLowerCase();
  const [c0, c1] = tokenIs0 ? [token, WHYPE] : [WHYPE, token];
  const zeroForOne = !tokenIs0; // buy token
  const poolKeyTuple = {
    name: "poolKey",
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  } as const;
  const paramsAbi = {
    type: "tuple",
    components: [poolKeyTuple, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }],
  } as const;
  const swapParams = encodeAbiParameters([paramsAbi], [{ poolKey: { currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: HOOK }, zeroForOne, amountIn, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: "0x" }]);
  const wrap = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDR_THIS, CONTRACT_BALANCE]);
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [WHYPE, CONTRACT_BALANCE, false]);
  const takeAll = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, 0n]);
  const actions = concatHex([toHex(0x06, { size: 1 }), toHex(0x0b, { size: 1 }), toHex(0x0f, { size: 1 })]);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, takeAll]]);
  return { commands: concatHex(["0x0b", "0x10"]), inputs: [wrap, v4Input], value: amountIn };
}

const forkChain = defineChain({
  id: 99901,
  name: "Elysium (fork)",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC_URL] } },
});

function waitForPort(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => fetch(url));
        resolve();
      } catch {
        if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`));
        setTimeout(tryOnce, 500);
      }
    };
    tryOnce();
  });
}

function freePort(port: number) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set<string>();
    for (const line of out.split("\n")) {
      if (line.includes(`:${port} `) && line.includes("LISTENING")) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== "0") pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    }
  } catch {
    /* best effort */
  }
}

export default async function globalSetup() {
  for (const port of [ANVIL_PORT, BRIDGE_PORT, APP_PORT]) freePort(port);

  // 1. Anvil forking REAL Elysium 99901.
  const anvil = spawn(
    "anvil",
    ["--fork-url", FORK_RPC, "--chain-id", "99901", "--port", String(ANVIL_PORT), "--silent", "--no-rate-limit"],
    { stdio: "ignore", detached: true },
  );
  await waitForPort(ANVIL_RPC_URL, 40_000);

  const account = privateKeyToAccount(ANVIL_PK);
  const pub = createPublicClient({ chain: forkChain, transport: http(ANVIL_RPC_URL) });
  const wallet = createWalletClient({ account, chain: forkChain, transport: http(ANVIL_RPC_URL) });

  // 2. Fund the dev EOA with HYPE.
  execFileSync("cast", ["rpc", "anvil_setBalance", account.address, "0x" + (100n * 10n ** 18n).toString(16), "--rpc-url", ANVIL_RPC_URL], { stdio: "ignore" });

  // 3. Launch + graduate a gen-5 token (the contracts are already live on 99901).
  const launchHash = await wallet.writeContract({
    address: FACTORY,
    abi: ballastFactoryV5Abi,
    functionName: "launch",
    args: ["E2E Gen5", "E2E5", 100, "ipfs://e2e", WHYPE, 10000, 0, 0],
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: launchHash });
  let token: Address | undefined;
  let feeRouter: Address | undefined;
  for (const log of rcpt.logs) {
    try {
      const p = decodeEventLog({ abi: ballastFactoryV5Abi, ...log });
      if (p.eventName === "Launched") {
        token = p.args.token as Address;
        feeRouter = p.args.feeRouter as Address;
      }
    } catch {
      /* not ours */
    }
  }
  if (!token || !feeRouter) throw new Error("could not read launched token");
  const gradHash = await wallet.writeContract({ address: FACTORY, abi: ballastFactoryV5Abi, functionName: "graduate", args: [token] });
  await pub.waitForTransactionReceipt({ hash: gradHash });

  // 3b. Priming buy: move price into the seeded range so active liquidity > 0 and the
  //     in-browser quote resolves for either token ordering.
  const prime = buildPrimingBuy(token, 2n * 10n ** 17n); // 0.2 HYPE
  const primeHash = await wallet.writeContract({
    address: UR,
    abi: universalRouterExecuteAbi,
    functionName: "execute",
    args: [prime.commands, prime.inputs, BigInt(Math.floor(Date.now() / 1000) + 600)],
    value: prime.value,
  });
  await pub.waitForTransactionReceipt({ hash: primeHash });

  writeFileSync(FIXTURE_PATH, JSON.stringify({ token, feeRouter, creator: account.address }, null, 2));

  // 4. Wallet bridge (signs with anvil #0, chainId 99901).
  const bridge = spawn("node", [path.join(__dirname, "..", "wallet-bridge.mjs")], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, BRIDGE_RPC_URL: ANVIL_RPC_URL, BRIDGE_PORT: String(BRIDGE_PORT), BRIDGE_CHAIN_ID: "99901", BRIDGE_NATIVE_SYMBOL: "HYPE" },
  });
  await waitForPort(`http://127.0.0.1:${BRIDGE_PORT}`, 10_000);

  // 5. next dev as the ELYSIUM deployment (gen-5), reads pointed at the fork.
  const nextDev = spawn("npx", ["next", "dev", "-p", String(APP_PORT)], {
    cwd: WEB_DIR,
    stdio: "ignore",
    detached: true,
    shell: true,
    env: {
      ...process.env,
      // Clear any Robinhood (gen-4) NEXT_PUBLIC address vars inherited from the repo
      // .env — on an Elysium build they would WRONGLY override the gen-5 defaults
      // (env wins in elysiumAddr). The real Elysium Vercel project simply doesn't set
      // these; the harness must reproduce that clean env.
      NEXT_PUBLIC_FACTORY_ADDRESS: "",
      NEXT_PUBLIC_V4_HOOK_ADDRESS: "",
      NEXT_PUBLIC_WETH_ADDRESS: "",
      NEXT_PUBLIC_POOL_MANAGER_ADDRESS: "",
      NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS: "",
      NEXT_PUBLIC_STATE_VIEW_ADDRESS: "",
      NEXT_PUBLIC_V4_QUOTER_ADDRESS: "",
      NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES: "",
      NEXT_PUBLIC_LENS_ADDRESS: "",
      NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS: "",
      NEXT_PUBLIC_SEEDER_ADDRESS: "",
      NEXT_PUBLIC_PROTOCOL_FEE_VAULT_ADDRESS: "",
      NEXT_PUBLIC_CHAIN: "elysium",
      NEXT_PUBLIC_REOWN_PROJECT_ID: "",
      RPC_UPSTREAM_URL: ANVIL_RPC_URL,
      // Point the BROWSER's client fallback (and wallet add-chain) at the fork too.
      // Elysium's real primary RPC is unreachable from CI, so without this a transient
      // /api/rpc dev-compile miss would fall back to a dead endpoint and every read
      // fails (unlike the Robinhood harness, whose public fallback is reachable).
      NEXT_PUBLIC_RPC_URL: ANVIL_RPC_URL,
      E2E_WALLET_BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
    },
  });
  await waitForPort(APP_URL, 90_000);

  // 6. Warm the routes a test lands on — AND the /api/rpc proxy itself, so its
  //    on-demand dev compile happens here, not racing the browser's first read.
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${APP_URL}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (const p of [`/app/token/${token}`, "/app/create"]) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`${APP_URL}${p}`);
        if (res.ok) break;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  writeFileSync(PIDS_FILE, JSON.stringify({ anvil: anvil.pid, bridge: bridge.pid, nextDev: nextDev.pid }));
}
