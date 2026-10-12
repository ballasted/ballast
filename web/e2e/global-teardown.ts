import { execFileSync } from "node:child_process";
import { readFileSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { FIXTURE_PATH } from "./fixture";

const WEB_DIR = path.join(__dirname, "..");
const ROUTES_FILE = path.join(WEB_DIR, "lib", "basketRoutes.ts");
const ROUTES_BACKUP = path.join(__dirname, ".basketRoutes.ts.bak");
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

  // `git checkout` instead of restoring from the backup copy: if a PREVIOUS
  // run was killed before teardown ran (e.g. a hung process force-killed
  // out-of-band), the backup itself could already be the test-fixture
  // content, which would silently re-commit it forever. Checking out the
  // last-committed version is correct regardless of how the previous run
  // ended, as long as the real file has no genuine uncommitted edits — which
  // is the expected state for this generated-looking file.
  try {
    execFileSync("git", ["checkout", "--", "lib/basketRoutes.ts"], { cwd: WEB_DIR, stdio: "ignore" });
  } catch {
    if (existsSync(ROUTES_BACKUP)) copyFileSync(ROUTES_BACKUP, ROUTES_FILE);
  }
  if (existsSync(ROUTES_BACKUP)) unlinkSync(ROUTES_BACKUP);

  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
}
