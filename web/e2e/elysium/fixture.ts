import { readFileSync } from "node:fs";
import path from "node:path";

// Elysium (gen-5) e2e fixture. Distinct ports from the Robinhood harness so both
// can coexist. The fork is anvil forking REAL Elysium mainnet (99901) via the
// public backup RPC (the primary rpc.elysium.kinetiq.xyz is unreachable from CI
// sandboxes; use a dedicated RPC via ELYSIUM_FORK_RPC for a reliable run).
export type ElysiumE2EFixture = {
  token: `0x${string}`;
  feeRouter: `0x${string}`;
  creator: `0x${string}`;
};

export const FIXTURE_PATH = path.join(__dirname, ".fixture.json");
export const ANVIL_PORT = 8547;
export const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const BRIDGE_PORT = 8767;
export const APP_PORT = 3011;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const FORK_RPC = process.env.ELYSIUM_FORK_RPC || "https://rpc.elyscan.live";

export function readFixture(): ElysiumE2EFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}
