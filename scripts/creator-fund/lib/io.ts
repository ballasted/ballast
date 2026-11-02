// Filesystem IO for the Creator Fund scripts: paths + JSON read/write helpers.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { REPO_ROOT } from "./env";

export const PATHS = {
  // Incremental scan state (derived cache — gitignored).
  state: resolve(REPO_ROOT, "data", "creator-fund", "state.json"),
  // Human-edited source of truth for confirmed winners (committed).
  confirmedSource: resolve(REPO_ROOT, "scripts", "creator-fund", "confirmed-winners.json"),
  // Mirrors + outputs the web app imports (committed so Vercel builds have them).
  confirmedMirror: resolve(REPO_ROOT, "web", "lib", "creator-fund", "data", "confirmed.json"),
  publicOut: resolve(REPO_ROOT, "web", "lib", "creator-fund", "data", "leaderboard.json"),
  adminOut: resolve(REPO_ROOT, "web", "lib", "creator-fund", "data", "admin.json"),
  payoutsDir: resolve(REPO_ROOT, "scripts", "creator-fund", "payouts"),
} as const;

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Copy the human-edited confirmed-winners.json into the web bundle (if it exists). */
export function mirrorConfirmed(): void {
  if (existsSync(PATHS.confirmedSource)) {
    mkdirSync(dirname(PATHS.confirmedMirror), { recursive: true });
    copyFileSync(PATHS.confirmedSource, PATHS.confirmedMirror);
  }
}
