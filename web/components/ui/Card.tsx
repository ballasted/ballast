import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Quiet surface for the feat/ui-overhaul pages: 20px radius, a single hairline
 * border, no heavy shadow (spec §1). Scoped to the rebuilt Token / Discover /
 * Analytics pages — the existing global `.card` (16px) is left untouched.
 */
export function Card({
  as,
  className,
  children,
  padded = true,
}: {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  padded?: boolean;
}) {
  const Tag = as ?? "div";
  return (
    <Tag
      className={cn(
        "rounded-card-lg border border-hairline bg-card",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
