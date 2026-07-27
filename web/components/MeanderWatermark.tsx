import { cn } from "@/lib/cn";

// A single very large Greek-key meander, outlined, bleeding off the top-right of
// the Discover and Analytics pages at ~2.5% opacity (density §1). It fills dead
// space with brand rather than decoration — the same motif as the section-rule
// Meander, scaled up. Pure SVG, pointer-events none, aria-hidden. Hidden on small
// screens (there is no dead space to fill on a phone). Never placed behind body
// text — callers position it in a corner of an overflow-hidden container.
export function MeanderWatermark({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute -right-16 -top-20 hidden text-bone/[0.025] md:block",
        className,
      )}
    >
      <svg width="440" height="440" viewBox="0 0 100 100" fill="none" role="presentation">
        {/* Square meander spiral — a single large key motif. */}
        <path
          d="M6 6 H94 V94 H20 V20 H80 V80 H34 V34 H66 V66 H48 V48"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinejoin="miter"
        />
      </svg>
    </div>
  );
}
