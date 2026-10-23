import type { Metadata } from "next";
import { AnalyticsView } from "@/components/app/analytics/AnalyticsView";

export const metadata: Metadata = { title: "Analytics · BALLAST" };

export default function AnalyticsPage() {
  return <AnalyticsView />;
}
