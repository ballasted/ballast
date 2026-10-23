import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * label / value / sub stack (spec §1). Numbers are tabular by default. Keep the
 * value a ReactNode so a `Skeleton`, `TokenAmount`, or `DeltaText` can be dropped
 * in while loading or for coloured deltas.
 */
export function Stat({
  label,
  value,
  sub,
  className,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-ui-xs text-text-muted">{label}</div>
      <div
        className={cn(
          "mt-1 truncate text-ui-lg font-semibold tabular-nums text-text-primary",
          valueClassName,
        )}
      >
        {value}
      </div>
      {sub != null ? (
        <div className="mt-0.5 truncate text-ui-xs tabular-nums text-text-faint">{sub}</div>
      ) : null}
    </div>
  );
}
