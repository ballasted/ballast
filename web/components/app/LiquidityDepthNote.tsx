import { isThinLiquidity } from "@/lib/liquidity";
import { cn } from "@/lib/cn";

// Factual pool-depth disclosure, as a chip — no warning triangle, no pulse.
// Renders only when the pool is thin enough that a small trade moves the price
// a lot (a 1 ETH opening is thin by design), so a healthy pool shows nothing.
export function LiquidityDepthNote({
  depthToDoubleUsd,
  className,
}: {
  depthToDoubleUsd?: number;
  className?: string;
}) {
  if (!isThinLiquidity(depthToDoubleUsd)) return null;
  return (
    <span
      className={cn("chip chip-warning", className)}
      title="A small trade moves this price significantly"
    >
      Thin liquidity
    </span>
  );
}
