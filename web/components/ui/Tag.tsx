import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Static rounded pill label (spec §1). Tone maps to the semantic palette; a Tag
// is non-interactive — use `Chip` when it needs to toggle.
export type TagTone =
  | "neutral"
  | "green"
  | "backing"
  | "burn"
  | "creator"
  | "staked"
  | "negative";

const TONE: Record<TagTone, string> = {
  neutral: "border-hairline bg-white/[0.03] text-text-secondary",
  green: "border-green/30 bg-green-bg text-green",
  backing: "border-backing/30 bg-backing/10 text-backing",
  burn: "border-burn/30 bg-burn/10 text-burn",
  creator: "border-creator-accent/30 bg-creator-accent/10 text-creator-accent",
  staked: "border-staked/30 bg-staked/10 text-staked",
  negative: "border-down/30 bg-down/10 text-down",
};

export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: TagTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-chip border px-2 py-0.5 text-ui-xs font-medium",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
