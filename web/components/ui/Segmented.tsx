"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  title?: string;
};

/**
 * Pill segmented control (spec §1): the active segment lifts to a raised fill,
 * inactive segments are muted. 200ms ease-out colour transition. Generic over a
 * string union so call sites stay type-safe.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-chip border border-hairline bg-bg/50 p-0.5",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-[8px] font-medium tabular-nums transition-colors duration-200 ease-out",
              size === "sm" ? "px-2.5 py-1 text-ui-xs" : "px-3 py-1.5 text-ui-sm",
              active
                ? "bg-surface-raised text-text-primary"
                : "text-text-muted hover:text-text-secondary",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
