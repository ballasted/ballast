// Public leaderboard data for /app/creator-fund. The scanner writes this committed
// JSON (web/lib/creator-fund/data/leaderboard.json); the page imports it statically
// so a Vercel build always ships the latest committed snapshot. Contains NO admin-
// only flag detail (that lives in admin.json, loaded only by the server admin page).
import type { PublicLeaderboard } from "../creatorFund";
import leaderboard from "./data/leaderboard.json";

export function getPublicLeaderboard(): PublicLeaderboard {
  return leaderboard as unknown as PublicLeaderboard;
}
