import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const PIDS_FILE = path.join(__dirname, ".pids.json");

export default async function globalTeardown() {
  if (!existsSync(PIDS_FILE)) return;
  try {
    const pids = JSON.parse(readFileSync(PIDS_FILE, "utf8")) as Record<string, number>;
    for (const pid of Object.values(pids)) {
      if (!pid) continue;
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
  } finally {
    try {
      unlinkSync(PIDS_FILE);
    } catch {
      /* ignore */
    }
  }
}
