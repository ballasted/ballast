import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { FIXTURE_PATH } from "./fixture";

const PIDS_FILE = path.join(__dirname, ".pids.json");

function killTree(pid: number) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* already dead */
  }
}

export default async function globalTeardown() {
  if (existsSync(PIDS_FILE)) {
    const pids = JSON.parse(readFileSync(PIDS_FILE, "utf8")) as Record<string, number>;
    for (const pid of Object.values(pids)) killTree(pid);
    unlinkSync(PIDS_FILE);
  }

  // The V4Router rewrite dropped the basketRoutes.ts override (NVDA is in the
  // production routable set now), so there's nothing to restore here any more.
  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
}
