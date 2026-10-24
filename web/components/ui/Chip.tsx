"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Interactive, selectable filter chip (spec §1 — 10px radius). Use for Discover
 * filters and chart overlay toggles. For a static, non-interactive label use
 * `Tag` instead.
 */
export function Chip({
  children,
  active = false,
  onClick,
  title,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-chip border px-3 py-1 text-ui-xs font-medium transition-colors duration-200 ease-out",
        active
          ? "border-green/40 bg-green-bg text-green"
          : "border-hairline bg-transparent text-text-muted hover:border-border hover:text-text-secondary",
        className,
      )}
    >
      {children}
    </button>
  );
}
