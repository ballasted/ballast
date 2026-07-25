import { AnalyticsView } from "@/components/app/analytics/AnalyticsView";
import { Meander } from "@/components/Meander";

export const metadata = { title: "Analytics · BALLAST" };

export default function AnalyticsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Analytics</h1>
        <Meander className="mt-3 max-w-xs" />
      </div>
      <AnalyticsView />
    </div>
  );
}
