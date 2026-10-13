import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANVIL_PORT, ANVIL_RPC_URL, BRIDGE_PORT, APP_PORT, APP_URL, FIXTURE_PATH, type BasketE2EFixture } from "./fixture";

const REPO_ROOT = path.join(__dirname, "..", "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const WEB_DIR = path.join(__dirname, "..");
const PIDS_FILE = path.join(__dirname, ".pids.json");

const ANVIL_EOA = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function readRootEnvVar(name: string): string {
  const envPath = path.join(REPO_ROOT, ".env");
  const content = readFileSync(envPath, "utf8");
  const line = content.split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not set in repo root .env`);
  return line.slice(name.length + 1).trim();
}

function waitForPort(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(
          () => fetch(url),
        );
        void res;
        resolve();
      } catch {
        if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`));
        setTimeout(tryOnce, 500);
      }
    };
    tryOnce();
  });
}

function castRpc(method: string, params: string[]) {
  execFileSync("cast", ["rpc", method, ...params, "--rpc-url", ANVIL_RPC_URL], { stdio: "pipe" });
}

export default async function globalSetup() {
  const rpcUrlPaid = readRootEnvVar("RH_RPC_URL_PAID");

  // 1. Start Anvil, forking real mainnet. Pin the fork a few blocks behind
  // head: this chain mints ~100ms blocks and the upstream RPC is not a full
  // archive, so forking at bare `latest` races state-pruning — anvil's lazy
  // per-slot fetch (and the EIP-1559 fee lookup at tx-send time) can hit
  // "historical state ... is not available" before setup finishes. A settled,
  // slightly-behind block is still inside the node's recent-state window, and
  // anvil caches every slot it touches from it. `--no-rate-limit` keeps the
  // burst of setup reads from being throttled.
  let forkBlock: number | undefined;
  try {
    const latest = Number(execFileSync("cast", ["block-number", "--rpc-url", rpcUrlPaid], { encoding: "utf8" }).trim());
    if (Number.isFinite(latest) && latest > 32) forkBlock = latest - 16;
  } catch {
    /* fall back to latest */
  }
  const anvilArgs = ["--fork-url", rpcUrlPaid, "--port", String(ANVIL_PORT), "--silent", "--no-rate-limit"];
  if (forkBlock !== undefined) anvilArgs.push("--fork-block-number", String(forkBlock));
  const anvil = spawn("anvil", anvilArgs, {
    stdio: "ignore",
    detached: true,
  });
  await waitForPort(ANVIL_RPC_URL, 30_000);

  // 2. Fund Anvil's well-known dev EOA with native ETH only. The V4Router
  // rewrite means the creator no longer needs to pre-hold WETH/NVDA — BasketZap
  // wraps native ETH via msg.value and swaps it through the REAL on-fork Ramses
  // NVDA pool. (The old flow needed WETH/NVDA because it seeded a throwaway
  // pool; that's gone.)
  castRpc("anvil_setBalance", [ANVIL_EOA, "0x" + (10n * 10n ** 18n).toString(16)]);

  // 3. Deploy BasketZap (new V4Router constructor) + create one fresh launch —
  // no TestPoolSeeder any more, the NVDA/WETH Ramses pool is real on the fork
  // (see contracts/script/e2e/DeploySetupBasketE2E.s.sol).
  const out = execFileSync(
    "forge",
    [
      "script",
      "script/e2e/DeploySetupBasketE2E.s.sol:DeploySetupBasketE2E",
      "--rpc-url",
      ANVIL_RPC_URL,
      "--broadcast",
      // Legacy gas pricing: forge then uses eth_gasPrice (answered from anvil's
      // cached fork state) instead of eth_feeHistory/EIP-1559 estimation, which
      // reads historical state the pruning upstream may no longer serve.
      "--legacy",
    ],
    { cwd: CONTRACTS_DIR, encoding: "utf8" },
  );
  const match = out.match(/===BASKET_E2E_JSON_START===\s*([\s\S]*?)\s*===BASKET_E2E_JSON_END===/);
  if (!match) throw new Error(`could not find fixture JSON in forge script output:\n${out}`);
  const fixture: BasketE2EFixture = JSON.parse(match[1]!.trim());
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));

  // 4. No basketRoutes.ts override: NVDA is in the PRODUCTION routable set now
  // (web/lib/basketRoutes.ts), so the picker uses the real config unchanged and
  // quotes the real on-fork Ramses route. Nothing to back up or restore.

  // 5. Start the wallet bridge (signs with Anvil's well-known dev key,
  // forwards everything else to the fork).
  const bridge = spawn("node", [path.join(__dirname, "wallet-bridge.mjs")], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, BRIDGE_RPC_URL: ANVIL_RPC_URL, BRIDGE_PORT: String(BRIDGE_PORT) },
  });
  await waitForPort(`http://127.0.0.1:${BRIDGE_PORT}`, 10_000);

  // 6. Start `next dev` with the fixture wired in. Server-side RPC reads
  // (/api/rpc) point at the SAME fork, so the app's own reads and the
  // injected wallet's writes see identical, consistent state.
  //
  // (A production build was tried instead, to avoid dev mode's on-demand
  // per-route compile causing a transient /api/rpc 502 the one time it raced
  // page load — but `next build` needs an external network fetch this
  // sandbox can't always complete (next/font), so it isn't reliable here
  // either. Back to `next dev`; the warm-up request below pre-compiles the
  // token page route before the real test navigates to it, which is the
  // actual fix for the race.)
  const nextDev = spawn("npx", ["next", "dev", "-p", String(APP_PORT)], {
    cwd: WEB_DIR,
    stdio: "ignore",
    detached: true,
    shell: true,
    env: {
      ...process.env,
      NEXT_PUBLIC_BASKET_ENABLED: "true",
      NEXT_PUBLIC_BASKET_ZAP_ADDRESS: fixture.basketZap,
      NEXT_PUBLIC_REOWN_PROJECT_ID: "",
      RPC_UPSTREAM_URL: ANVIL_RPC_URL,
      E2E_WALLET_BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
    },
  });
  await waitForPort(APP_URL, 60_000);

  // Warm-up: hit every route a test will land on (and have each settle) once
  // before Playwright's real tests navigate there, so each route's on-demand
  // dev compile and its first /api/rpc round-trip both happen here, not
  // mid-test. This matters even for routes a test only reaches via a
  // CLIENT-SIDE <Link> click (never a full page.goto): Next dev's on-demand
  // compile for a never-before-visited route can race that client-side
  // transition and silently swallow it (confirmed this session —
  // /app/backing/[address] via the token page's summary-card link).
  for (const path of [`/app/token/${fixture.token}`, `/app/backing/${fixture.token}`, "/app/backing"]) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`${APP_URL}${path}`);
        if (res.ok) break;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  writeFileSync(
    PIDS_FILE,
    JSON.stringify({ anvil: anvil.pid, bridge: bridge.pid, nextDev: nextDev.pid }),
  );
}
