import { TeamSplitPanel } from "@/components/app/TeamSplitPanel";
import { isCreatorSplitterConfigured } from "@/lib/contracts";

export const metadata = { title: "Team split · BALLAST" };

// Standalone team-split tool (NOT a Create step): realCreator is immutable, so a
// splitter is a payout target a creator points their fee share at. The split only
// applies to fees sent to the splitter. Gated behind NEXT_PUBLIC_CREATOR_SPLITTER_FACTORY.
export default function TeamSplitPage() {
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Team split</h1>
        <p className="text-sm text-text-muted">
          Deploy a splitter and point your creator fee share at it. The split applies only to fees
          sent to the splitter.
        </p>
      </header>

      {isCreatorSplitterConfigured ? (
        <TeamSplitPanel />
      ) : (
        <div className="note note-neutral">Team split is not available yet.</div>
      )}
    </div>
  );
}
