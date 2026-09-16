import { cn } from "@/lib/cn";

// Background treatment for large empty areas (spec §3, "Surface style") — never
// a flat black expanse. Wraps the existing fixed glow+noise layer (globals.css
// `.ambient-bg` / `.ambient-bg-marketing`, which also now carries the 80px grid,
// masked by a radial gradient) and, for `variant="hero"`, adds 2–3 heavily
// blurred out-of-focus patina discs at the edges. Purely decorative (`aria-hidden`)
// and non-interactive; the discs are static (no motion), so there's nothing for
// `prefers-reduced-motion` to strip here beyond what globals.css already handles
// for the layer's siblings.
const HERO_DISCS = [
  { top: "-8%", left: "-6%", size: 340 },
  { top: "52%", left: "84%", size: 260 },
  { top: "86%", left: "6%", size: 200 },
];

export function Ambience({
  variant = "page",
  className,
}: {
  variant?: "page" | "hero";
  className?: string;
}) {
  const layerClass = variant === "hero" ? "ambient-bg-marketing" : "ambient-bg";
  return (
    <div className={cn(layerClass, className)} aria-hidden>
      {variant === "hero" &&
        HERO_DISCS.map((disc, i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              top: disc.top,
              left: disc.left,
              width: disc.size,
              height: disc.size,
              background: "radial-gradient(circle, rgba(34,201,58,0.16), rgba(34,201,58,0) 70%)",
              filter: "blur(40px)",
            }}
          />
        ))}
    </div>
  );
}
