import "server-only";
// Admin leaderboard data (includes per-swap / per-holder flag detail for manual
// review). SERVER-ONLY: the `server-only` import makes this a build error if it is
// ever pulled into a client bundle, so the flags can never leak to the browser. Read
// exclusively by the env-gated server admin page (/app/creator-fund/admin).
import type { AdminLeaderboard } from "../creatorFund";
import admin from "./data/admin.json";

export function getAdminLeaderboard(): AdminLeaderboard {
  return admin as unknown as AdminLeaderboard;
}
