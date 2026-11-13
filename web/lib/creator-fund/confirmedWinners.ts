// The human-committed confirmed-winners list is the SINGLE authority on who is paid.
// It lives at the repo root (scripts/creator-fund/confirmed-winners.json) so the
// human edits/commits it directly; the app reads a copy mirrored into the web bundle
// by the scanner (data/confirmed.json) via a static import, so a Vercel build always
// has it. A token is a "winner" (counts against the 10 spots, shows a Funded badge)
// ONLY when present here — never automatically from the scan.
import type { ConfirmedWinner } from "../creatorFund";
import confirmed from "./data/confirmed.json";

export function confirmedWinners(): ConfirmedWinner[] {
  return (confirmed as { winners?: ConfirmedWinner[] }).winners ?? [];
}

export function confirmedWinnerCount(): number {
  return confirmedWinners().length;
}
