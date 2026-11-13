import { profile, isElysium } from "@/lib/chainProfile";

// A slim banner linking to the OTHER Ballast app (Robinhood ⇄ Elysium). Shows which
// chain THIS deployment runs and offers a one-click hop to the other. The target URL
// is set per-deployment (NEXT_PUBLIC_ROBINHOOD_APP_URL / NEXT_PUBLIC_ELYSIUM_APP_URL).
export function CrossAppSwitch() {
  const here = isElysium ? "Elysium · Gen 5 beta" : "Robinhood Chain";
  return (
    <div className="mb-4 flex items-center justify-between rounded-md border border-hairline bg-bg-elevated px-3 py-1.5 text-xs">
      <span className="text-text-faint">
        You’re on <span className="text-text-secondary">{here}</span>
      </span>
      <a
        className="chip chip-accent hover:opacity-90"
        href={profile.crossApp.href}
        target="_blank"
        rel="noreferrer"
      >
        {profile.crossApp.label} →
      </a>
    </div>
  );
}
