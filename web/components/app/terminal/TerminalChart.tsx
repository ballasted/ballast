"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Freshness } from "@/components/app/Freshness";
import { TIMEFRAMES, formatSmallUsd, formatCompactUsd, type Candle, type Timeframe } from "@/lib/market";
import { cn } from "@/lib/cn";

// Palette, verbatim from the terminal spec — kept as literals so the SVG doesn't
// depend on Tailwind fill utilities resolving our custom tokens. Green for up/buys,
// a MUTED red for down that reads as information, not alarm (no bright #FF0000).
const UP = "#22C93A";
const DOWN = "#C15B4C";
const GROUND = "#050A06";
const GRID = "rgba(245,243,236,0.06)";
const AXIS = "rgba(245,243,236,0.38)";

const H = 380; // plot height in px (desktop-dense)
const AXIS_W = 66; // right price-axis gutter
const PAD_TOP = 10;
const PAD_BOTTOM = 22; // room for the sparse time axis

// A dependency-free candlestick chart (same philosophy as BarChart.tsx — no recharts
// in the bundle). Draws candles, a right-hand price axis, a current-price tag, and a
// hover crosshair that drives the OHLC readout in the header. No motion: a candle is a
// value, and a value may not animate (hard rule) — so reduced-motion needs nothing
// disabled here. The backing line is deliberately NOT drawn: today's backing figure
// painted across historical candles would assert a past value that wasn't true.
export function TerminalChart({
  candles,
  timeframe,
  onTimeframe,
  source,
  fetchedAt,
  loading,
  available,
}: {
  candles: Candle[];
  timeframe: Timeframe;
  onTimeframe: (tf: Timeframe) => void;
  source: string;
  fetchedAt?: number;
  loading: boolean;
  available: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The readout reflects the hovered candle, else the most recent one.
  const readout = candles.length > 0 ? (candles[hover ?? candles.length - 1] ?? candles[candles.length - 1]) : undefined;

  return (
    <section className="card overflow-hidden p-0">
      {/* Header: OHLC readout · timeframe · source */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <Ohlc c={readout} />
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-full border border-border p-0.5">
            {TIMEFRAMES.map((t) => (
              <button
                key={t.key}
                onClick={() => onTimeframe(t.key)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs tabular-nums transition-colors",
                  t.key === timeframe ? "bg-green text-bg font-semibold" : "text-text-muted hover:text-text-secondary",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Freshness updatedAt={fetchedAt} source={source} unavailable={!available && !loading} />
        </div>
      </div>

      {/* Plot */}
      <div ref={wrapRef} className="relative w-full" style={{ height: H }}>
        {w > 0 && available && candles.length > 0 ? (
          <Candles candles={candles} w={w} hover={hover} setHover={setHover} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-text-muted">
            {loading
              ? "Loading price history…"
              : "No market data for this token yet. Price history appears once GeckoTerminal indexes a pool with enough liquidity."}
          </div>
        )}
      </div>
    </section>
  );
}

function Candles({
  candles,
  w,
  hover,
  setHover,
}: {
  candles: Candle[];
  w: number;
  hover: number | null;
  setHover: (i: number | null) => void;
}) {
  const plotW = Math.max(1, w - AXIS_W);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const n = candles.length;
  const last = candles[n - 1];
  if (!last) return null;
  const step = plotW / n;
  const bodyW = Math.max(1, Math.min(step * 0.62, 14));

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  const pad = (hi - lo) * 0.06 || hi * 0.06 || 1;
  lo -= pad;
  hi += pad;
  const span = hi - lo || 1;
  const y = (price: number) => PAD_TOP + ((hi - price) / span) * plotH;
  const x = (i: number) => i * step + step / 2;

  const lastY = y(last.c);
  const lastUp = last.c >= last.o;

  // 5 horizontal price gridlines + labels.
  const ticks = Array.from({ length: 5 }, (_, i) => lo + (span * i) / 4);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px > plotW) return setHover(null);
    const i = Math.floor(px / step);
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <svg
      width={w}
      height={H}
      className="block"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label={`Price candlestick chart, ${n} periods`}
    >
      {/* Gridlines + right-axis price labels */}
      {ticks.map((p, i) => (
        <g key={i}>
          <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke={GRID} strokeWidth={1} />
          <text x={plotW + 6} y={y(p) + 3} fontSize={10} fill={AXIS} className="tabular-nums">
            {formatSmallUsd(p)}
          </text>
        </g>
      ))}

      {/* Hover crosshair */}
      {hover != null && candles[hover] && (
        <line x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={AXIS} strokeWidth={1} strokeDasharray="2 3" />
      )}

      {/* Candles */}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const color = up ? UP : DOWN;
        const cx = x(i);
        const openY = y(c.o);
        const closeY = y(c.c);
        const top = Math.min(openY, closeY);
        const bh = Math.max(1, Math.abs(closeY - openY));
        return (
          <g key={i} opacity={hover == null || hover === i ? 1 : 0.55}>
            <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} />
            <rect x={cx - bodyW / 2} y={top} width={bodyW} height={bh} fill={color} />
          </g>
        );
      })}

      {/* Current-price tag on the right axis */}
      <g>
        <line x1={0} x2={plotW} y1={lastY} y2={lastY} stroke={lastUp ? UP : DOWN} strokeWidth={1} strokeDasharray="1 2" opacity={0.5} />
        <rect x={plotW} y={lastY - 8} width={AXIS_W} height={16} fill={lastUp ? UP : DOWN} rx={2} />
        <text x={plotW + AXIS_W / 2} y={lastY + 3} fontSize={10} fill={GROUND} textAnchor="middle" className="tabular-nums font-semibold">
          {formatSmallUsd(last.c)}
        </text>
      </g>
    </svg>
  );
}

function Ohlc({ c }: { c?: Candle }) {
  if (!c) return <div className="text-xs text-text-faint">—</div>;
  const up = c.c >= c.o;
  const cls = up ? "text-positive" : "text-negative";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums">
      {(
        [
          ["O", c.o],
          ["H", c.h],
          ["L", c.l],
          ["C", c.c],
        ] as const
      ).map(([k, v]) => (
        <span key={k} className="text-text-faint">
          {k} <span className={cls}>{formatSmallUsd(v)}</span>
        </span>
      ))}
      <span className="text-text-faint">
        V <span className="text-text-secondary">{formatCompactUsd(c.v)}</span>
      </span>
    </div>
  );
}
