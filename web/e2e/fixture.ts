import { readFileSync } from "node:fs";
import path from "node:path";

export type BasketE2EFixture = {
  basketZap: `0x${string}`;
  token: `0x${string}`;
  treasury: `0x${string}`;
  creator: `0x${string}`;
  nvda: `0x${string}`;
  // V4Router rewrite: the basket swaps NVDA through the REAL on-fork Ramses
  // route (index 0, WETH/NVDA direct) — no seeded pool, no route override. NVDA
  // is in the production routable set (web/lib/basketRoutes.ts) so the picker
  // uses the real config unchanged.
  ramsesHopIdx: number[];
};

export const FIXTURE_PATH = path.join(__dirname, ".fixture.json");
export const ANVIL_PORT = 8555;
export const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const BRIDGE_PORT = 8766;
export const APP_PORT = 3010;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

export function readFixture(): BasketE2EFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}
