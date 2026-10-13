import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { ANVIL_PORT, ANVIL_RPC_URL, BRIDGE_PORT, APP_PORT, APP_URL, FIXTURE_PATH, type BasketE2EFixture } from "./fixture";

const REPO_ROOT = path.join(__dirname, "..", "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const WEB_DIR = path.join(__dirname, "..");
const ROUTES_FILE = path.join(WEB_DIR, "lib", "basketRoutes.ts");
const ROUTES_BACKUP = path.join(__dirname, ".basketRoutes.ts.bak");
const PIDS_FILE = path.join(__dirname, ".pids.json");

const ANVIL_EOA = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
// Discovered once via forge-std's stdStorage.find() against this exact EOA —
// see docs/BASKET_DISCOVERY.md / commit history for the derivation. These
// proxy stock tokens use namespaced (non-sequential) storage, so this exact
// slot is specific to ANVIL_EOA, not re-derivable by a naive base-slot guess.
const WETH_SLOT = "0xf6d04bbe1a75429862aa97cc198c639a5559580c07ae94016a2b25986f2e3abd";
const NVDA_SLOT = "0x03b401b7b39ad5148aeb9ef28bef316a982c01bdaadee32abc45fed3bc7f4746";

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

  // 1. Start Anvil, forking real mainnet.
  const anvil = spawn("anvil", ["--fork-url", rpcUrlPaid, "--port", String(ANVIL_PORT), "--silent"], {
    stdio: "ignore",
    detached: true,
  });
  await waitForPort(ANVIL_RPC_URL, 30_000);

  // 2. Fund Anvil's well-known dev EOA with real WETH/NVDA for real, directly
  // on the live node — vm.deal in a forge SCRIPT only mutates forge's own
  // local simulation and never reaches a separately-running node once the
  // script replays its broadcast transactions (confirmed empirically this
  // session), so funding must happen via Anvil's own RPC extension first.
  castRpc("anvil_setStorageAt", [WETH, WETH_SLOT, "0x0000000000000000000000000000000000000000000000000000000000000000"]);
  castRpc("anvil_setStorageAt", [WETH, WETH_SLOT, "0x" + (50n * 10n ** 18n).toString(16).padStart(64, "0")]);
  castRpc("anvil_setStorageAt", [NVDA, NVDA_SLOT, "0x" + (1_000_000n * 10n ** 18n).toString(16).padStart(64, "0")]);
  castRpc("anvil_setBalance", [ANVIL_EOA, "0x" + (10n * 10n ** 18n).toString(16)]);

  // 3. Deploy BasketZap, seed a real local pool, create one fresh launch —
  // all genuine broadcast transactions now that the EOA really holds the
  // tokens on this live fork (see contracts/script/e2e/DeploySetupBasketE2E.s.sol).
  const out = execFileSync(
    "forge",
    [
      "script",
      "script/e2e/DeploySetupBasketE2E.s.sol:DeploySetupBasketE2E",
      "--rpc-url",
      ANVIL_RPC_URL,
      "--broadcast",
    ],
    { cwd: CONTRACTS_DIR, encoding: "utf8" },
  );
  const match = out.match(/===BASKET_E2E_JSON_START===\s*([\s\S]*?)\s*===BASKET_E2E_JSON_END===/);
  if (!match) throw new Error(`could not find fixture JSON in forge script output:\n${out}`);
  const fixture: BasketE2EFixture = JSON.parse(match[1]!.trim());
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));

  // 4. Temporarily point the picker at the locally-seeded NVDA route. Backed
  // up and restored in global-teardown — production basketRoutes.ts ships
  // empty (docs/BASKET_DISCOVERY.md §2) and must not change.
  copyFileSync(ROUTES_FILE, ROUTES_BACKUP);
  const testRoutes = `import type { Address } from "viem";
export type BasketRoute = { fee: number; tickSpacing: number; hooks: Address };
// E2E TEST FIXTURE — overwritten by web/e2e/global-setup.ts, restored by
// web/e2e/global-teardown.ts. Never commit this version.
export const BASKET_ROUTES: Record<string, BasketRoute> = {
  "${fixture.nvda.toLowerCase()}": { fee: ${fixture.fee}, tickSpacing: ${fixture.tickSpacing}, hooks: "0x0000000000000000000000000000000000000000" },
};
export function routeFor(asset: Address): BasketRoute | undefined { return BASKET_ROUTES[asset.toLowerCase()]; }
export function isRoutable(asset: Address): boolean { return routeFor(asset) !== undefined; }
export type BasketPresetId = "index" | "aiChips" | "cashLike" | "custom";
export const BASKET_PRESETS: { id: BasketPresetId; label: string; tickers: string[] }[] = [
  { id: "index", label: "Index", tickers: ["SPY", "QQQ"] },
  { id: "aiChips", label: "AI chips", tickers: ["NVDA", "AMD", "PLTR"] },
  { id: "cashLike", label: "Cash-like", tickers: ["SGOV"] },
  { id: "custom", label: "Custom", tickers: [] },
];
`;
  writeFileSync(ROUTES_FILE, testRoutes);

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
