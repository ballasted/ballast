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

// Kill anything already LISTENING on a port we're about to bind. A prior run
// that was interrupted (or whose teardown didn't fire) can leave anvil / the
// bridge / next-dev holding these ports; the new process then fails to bind
// but `waitForPort` still succeeds against the STALE one, so the whole suite
// silently runs against a hours-old fork whose pool state is long pruned —
// every quote comes back as dust. (This cost a long debugging detour; the
// fix is to never inherit a stale listener.) Windows-specific (netstat +
// taskkill); the harness only runs on this sandbox.
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
        /* already gone */
      }
    }
  } catch {
    /* netstat unavailable — best effort */
  }
}

export default async function globalSetup() {
  const rpcUrlPaid = readRootEnvVar("RH_RPC_URL_PAID");

  // 0. Reclaim our ports from any orphaned prior-run processes (see freePort).
  for (const port of [ANVIL_PORT, BRIDGE_PORT, APP_PORT]) freePort(port);

  // 1. Start Anvil, forking real mainnet. Pin the fork a few blocks behind
  // head: this chain mints ~100ms blocks and the upstream RPC is not a full
  // archive, so forking at bare `latest` races state-pruning — anvil's lazy
  // per-slot fetch (and the EIP-1559 fee lookup at tx-send time) can hit
  // "historical state ... is not available" before setup finishes. A settled,
  // slightly-behind block is still inside the node's recent-state window, and
  // anvil caches every slot it touches from it. `--no-rate-limit` keeps the
  // burst of setup reads from being throttled.
  // Fork at bare `latest` (no pin): the freshest block is the one the
  // non-archive upstream is most certain to still serve when anvil lazily
  // fetches a slot. (The deploy's EIP-1559 historical-state error is handled
  // by `--legacy` on the forge script, so the old `latest-16` pin — which just
  // moved the fork further into the pruning window — is no longer needed.)
  const anvilArgs = ["--fork-url", rpcUrlPaid, "--port", String(ANVIL_PORT), "--silent", "--no-rate-limit"];
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

  // 2b. PRE-WARM anvil's fork cache for the NVDA/WETH Ramses quote+swap path,
  // RIGHT NOW — before the ~60s forge deploy. The fork is pinned to a block
  // captured at startup; this chain mints ~100ms blocks and the upstream RPC is
  // not a full archive, so by the time the forge deploy finishes (~600 blocks
  // later) that block's state is already pruned — anvil's lazy per-slot fetch
  // then returns EMPTY, and the Ramses quote comes back as dust (which the
  // app's liquidity gate correctly rejects — docs/DECISIONS.md §9), stranding
  // the e2e. Replaying the exact quote through anvil in this window, while the
  // block's state is still served, caches the pool/quoter/tick slots in anvil's
  // in-memory fork cache; every later read (the in-browser quote AND the swap,
  // which crosses the same ticks) then hits the cache instead of a dead
  // upstream. Warm the sizes the specs use.
  const RAMSES_QUOTER = "0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6";
  const NVDA_ADDR = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
  const WETH_ADDR = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  for (const amt of ["200000000000000000", "500000000000000000", "1000000000000000000"]) {
    try {
      const warm = execFileSync(
        "cast",
        [
          "call",
          RAMSES_QUOTER,
          "quoteExactInputSingle((address,address,uint256,int24,uint160))(uint256,uint160,uint32,uint256)",
          `(${WETH_ADDR},${NVDA_ADDR},${amt},50,0)`,
          "--rpc-url",
          ANVIL_RPC_URL,
        ],
        { encoding: "utf8" },
      );
      console.log(`[warm] NVDA ${amt} -> ${warm.trim().split("\n")[0]}`);
    } catch (e) {
      console.log(`[warm] NVDA ${amt} FAILED: ${(e as Error).message.split("\n")[0]}`);
    }
  }

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
