import { cn } from "@/lib/cn";

/**
 * Signed percentage / delta with up(green) / down(red) colour (spec §1). Renders
 * a muted "—" when the value genuinely does not exist (null / NaN) — callers
 * should show a Skeleton instead while merely loading.
 */
export function DeltaText({
  value,
  suffix = "%",
  decimals = 2,
  className,
}: {
  value: number | null | undefined;
  suffix?: string;
  decimals?: number;
  className?: string;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <span className={cn("tabular-nums text-text-muted", className)}>—</span>;
  }
  const up = value > 0;
  const down = value < 0;
  const sign = up ? "+" : down ? "−" : "";
  const body = Math.abs(value).toFixed(decimals);
  return (
    <span
      className={cn(
        "tabular-nums",
        up && "text-up",
        down && "text-down",
        !up && !down && "text-text-muted",
        className,
      )}
    >
      {sign}
      {body}
      {suffix}
    </span>
  );
}
