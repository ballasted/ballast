import { redirect } from "next/navigation";

// Ballasted is the default surface — the positioning is structural, not cosmetic.
export default function AppIndex() {
  redirect("/app/discover");
}
