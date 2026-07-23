import { cn } from "@/lib/cn";

// Greek meander — the brand pattern, used as a section rule (spec 4.2). Sparingly:
// two per screen maximum (e.g. under a page title, above the footer, or as the
// divider inside the backing panel). Pure SVG, no client JS, so it is shared by
// marketing and /app without adding anything to either bundle. Decorative only.
//
// The two horizontal rails are continuous across tiles, so the pattern repeats
// seamlessly at any width; the internal hook is the key motif. Rendered in bone at
// low opacity so it reads as a quiet rule, never decoration competing with data.
export function Meander({ className }: { className?: string }) {
  return (
    <div className={cn("h-4 w-full text-bone/20", className)} aria-hidden>
      <svg width="100%" height="16" role="presentation" className="block">
        <defs>
          <pattern id="ballast-meander" width="20" height="16" patternUnits="userSpaceOnUse">
            <path
              d="M0 1.5 H20 M0 14.5 H20 M4 1.5 V11 H14 V5 H9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="100%" height="16" fill="url(#ballast-meander)" />
      </svg>
    </div>
  );
}
