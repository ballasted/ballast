import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

/**
 * Shimmer loading placeholder (spec §1). A surface that is still fetching shows
 * one of these instead of an empty box or a misleading "—". The `.skeleton`
 * shimmer is defined in globals.css and auto-settles to a flat fill under
 * prefers-reduced-motion.
 */
export function Skeleton({
  className,
  width,
  height,
  rounded = "rounded-md",
}: {
  className?: string;
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  rounded?: string;
}) {
  return (
    <span
      role="presentation"
      aria-hidden
      className={cn("skeleton block", rounded, className)}
      style={{ width, height }}
    />
  );
}
