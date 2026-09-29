import { redirect } from "next/navigation";

// Analytics was removed from navigation. Redirect old bookmarks/links to
// Discover rather than 404.
export default function AnalyticsPage() {
  redirect("/app/discover");
}
