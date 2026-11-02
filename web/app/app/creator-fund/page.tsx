import type { Metadata } from "next";
import { CreatorFundView } from "@/components/app/creator-fund/CreatorFundView";
import { getPublicLeaderboard } from "@/lib/creator-fund/publicData";
import { confirmedWinnerCount } from "@/lib/creator-fund/confirmedWinners";

export const metadata: Metadata = {
  title: "Creator Fund · BALLAST",
  description: "First 10 eligible tokens to reach $50k volume and 100 holders within 14 days.",
};

// Public campaign page. Data comes from the committed scanner output (no live chain
// reads on page load); countdowns tick client-side. See CreatorFundView.
export default function CreatorFundPage() {
  return <CreatorFundView board={getPublicLeaderboard()} confirmedCount={confirmedWinnerCount()} />;
}
