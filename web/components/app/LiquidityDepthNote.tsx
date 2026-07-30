import { isThinLiquidity } from "@/lib/liquidity";
import { cn } from "@/lib/cn";

// Static, factual pool-depth disclosure — no warning triangle, no pulse. Same
// discipline as the backing panel: state what's true and let the reader decide.
// Renders only when the pool is thin enough that a small trade moves the price a
// lot (a 1 ETH opening is thin by design), so a healthy pool shows nothing.
export function LiquidityDepthNote({
  depthToDoubleUsd,
  className,
}: {
  depthToDoubleUsd?: number;
  className?: string;
}) {
  if (!isThinLiquidity(depthToDoubleUsd)) return null;
  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-text-faint", className)}>
      <span aria-hidden>•</span>
      Thin liquidity — a few hundred dollars moves this price significantly.
    </p>
  );
}
