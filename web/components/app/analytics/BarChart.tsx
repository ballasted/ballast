"use client";

// Minimal daily bar chart — inline SVG, zero dependencies, so it adds nothing to
// the /app bundle (no recharts/d3). Uses the brand chart-series colours from the
// visual-upgrade palette: the latest bar is patina green (the live one), earlier
// bars are the muted mid-green. Bars grow from 0 on first paint via the shared
// .bar-grow rule, which prefers-reduced-motion disables. A proportion may
// animate; a value may not (Phase 3 hard rule 2) — these are counts/volumes
// drawn at their true height, only the reveal animates.
export function BarChart({
  data,
  formatValue,
  ariaLabel,
}: {
  data: { label: string; value: number }[];
  formatValue: (n: number) => string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const lastIdx = data.length - 1;

  return (
    <figure aria-label={ariaLabel}>
      <div className="flex h-40 items-end gap-1" role="img" aria-label={ariaLabel}>
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const isLast = i === lastIdx;
          return (
            <div key={i} className="group relative flex h-full flex-1 items-end">
              <div
                className={`bar-grow w-full rounded-t-sm ${isLast ? "bg-data-1" : "bg-data-2"}`}
                style={{ height: `${Math.max(pct, 1.5)}%` }}
              >
                <title>
                  {d.label}: {formatValue(d.value)}
                </title>
              </div>
              {/* Value on hover, tabular so it doesn't jitter. */}
              <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-surface-raised px-1.5 py-0.5 text-[10px] tabular-nums text-text-secondary group-hover:block">
                {formatValue(d.value)}
              </span>
            </div>
          );
        })}
      </div>
      {/* Sparse axis: first and last day only, so a 30-bar strip stays legible. */}
      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-text-faint">
        <span>{data[0]?.label}</span>
        <span>{data[lastIdx]?.label}</span>
      </div>
    </figure>
  );
}
