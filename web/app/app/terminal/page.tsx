import { redirect } from "next/navigation";

// Terminal was removed from navigation (its 7 dedicated panel components were
// dead code once the nav entry went away). Redirect old bookmarks/links to
// Discover rather than 404.
export default function TerminalIndexPage() {
  redirect("/app/discover");
}
