import { StubScreen } from "@/components/app/StubScreen";

export default function CreatePage() {
  return (
    <div className="space-y-4">
      <StubScreen
        title="Create"
        body="The 3-step launch flow (Project → Treasury → Review) lands here, built on BallastFactory."
      />
      {/* Zero-allocation fact — surfaced up front, never discovered at confirmation. */}
      <section className="card border-warning-border bg-warning-bg p-4">
        <h2 className="text-sm font-semibold text-warning">You receive no token allocation</h2>
        <p className="mt-2 text-sm text-text-secondary">
          100% of the supply seeds the pool. There is no presale, team, or creator
          allocation — you hold none of the token at launch and earn only from the
          swap fee. This is a deliberate anti-rug property: there is no founder bag
          to dump. If you expected an allocation, this is not that kind of launchpad.
        </p>
      </section>
    </div>
  );
}
