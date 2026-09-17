"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
// Overlay/indicator colors, pulled from the existing chart-series ramp
// (tailwind.config.ts `data.*`) rather than inventing a new hue — the shorter MA
// reuses the same green as up-candles, the longer MA gets the muted secondary
// step (data.4), RSI's own line gets a third, distinct ramp step (data.5) so it
// never reads as "the same series" as the long MA even though both can be on
// screen at once (different panels), and reference lines use the warning token.
const MA_SHORT = "#22C93A"; // = UP / data.1 — short-period MA
const MA_LONG = "#6E8B77"; // data.4 — muted secondary overlay
const RSI_LINE = "#C9A96A"; // data.5 — RSI's own line, distinct from both MA lines
const WARNING = "#E8A33D";

const AXIS_W = 66; // right price-axis gutter
const PAD_TOP = 10;
const PAD_BOTTOM = 22; // room for the sparse time axis, drawn once under the price panel
const PRICE_H = 340;
const VOL_H = 70;
const RSI_H = 70;
const PANEL_GAP = 10;

type ChartType = "candles" | "line";
type Tool = "cursor" | "hline" | "trend";
type Drawing = { type: "hline"; price: number } | { type: "trend"; i1: number; p1: number; i2: number; p2: number };

function totalHeight(showVolume: boolean, showRsi: boolean): number {
  let h = PRICE_H;
  if (showVolume) h += PANEL_GAP + VOL_H;
  if (showRsi) h += PANEL_GAP + RSI_H;
  return h;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Simple moving average, aligned to the input array (undefined until `period`
// values have accumulated — never a guess at a value that isn't there yet).
function sma(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(values.length).fill(undefined);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Wilder's RSI(period). Undefined until `period` deltas exist.
function rsi(values: number[], period = 14): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(values.length).fill(undefined);
  if (values.length < period + 1) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function fmtTime(t: number): string {
  const d = new Date(t * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// A dependency-free candlestick chart (same philosophy as BarChart.tsx — no recharts
// in the bundle). Draws candles, a right-hand price axis, a current-price tag, a
// hover crosshair with a floating OHLC tooltip, and optional MA/Volume/RSI overlays —
// all computed from the real candle series already fetched (GeckoTerminal), never
// mock data. Pan (drag) and zoom (wheel/pinch) move a visible-range window over the
// same series; nothing here re-fetches or re-derives price, it only changes what
// slice of the already-real data is on screen. The backing line is deliberately NOT
// drawn: today's backing figure painted across historical candles would assert a
// past value that wasn't true.
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
  const [hover, setHover] = useState<number | null>(null); // absolute index into `candles`
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [showMa, setShowMa] = useState(false);
  const [maShortPeriod, setMaShortPeriod] = useState(7);
  const [maLongPeriod, setMaLongPeriod] = useState(25);
  const [showVolume, setShowVolume] = useState(false);
  const [showRsi, setShowRsi] = useState(false);
  const [tool, setTool] = useState<Tool>("cursor");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [range, setRange] = useState<{ start: number; count: number }>({ start: 0, count: 0 });
  const prevLenRef = useRef(0);

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

  // A timeframe switch is a fresh dataset — old candle indices (and any
  // drawings/hover anchored to them) stop meaning anything.
  useEffect(() => {
    setRange({ start: 0, count: candles.length });
    setDrawings([]);
    setTool("cursor");
    setHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe]);

  // New candles arriving on the SAME timeframe (polling) extend the array in
  // place. Stay pinned to the latest candle if that's where the view already
  // was; otherwise leave a panned-into-history view exactly where it was.
  useEffect(() => {
    const prevLen = prevLenRef.current;
    prevLenRef.current = candles.length;
    if (candles.length === 0) return;
    setRange((r) => {
      if (r.count === 0) return { start: 0, count: candles.length };
      const wasPinnedToEnd = r.start + r.count >= prevLen;
      const count = Math.min(r.count, candles.length);
      const maxStart = Math.max(0, candles.length - count);
      const start = wasPinnedToEnd ? maxStart : clamp(r.start, 0, maxStart);
      return { start, count };
    });
  }, [candles.length]);

  const readout = candles.length > 0 ? (candles[hover ?? candles.length - 1] ?? candles[candles.length - 1]) : undefined;
  const h = totalHeight(showVolume, showRsi);

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

      <Toolbar
        chartType={chartType}
        setChartType={setChartType}
        showMa={showMa}
        setShowMa={setShowMa}
        maShortPeriod={maShortPeriod}
        setMaShortPeriod={setMaShortPeriod}
        maLongPeriod={maLongPeriod}
        setMaLongPeriod={setMaLongPeriod}
        showVolume={showVolume}
        setShowVolume={setShowVolume}
        showRsi={showRsi}
        setShowRsi={setShowRsi}
        tool={tool}
        setTool={setTool}
        hasDrawings={drawings.length > 0}
        onClear={() => setDrawings([])}
      />

      {/* Plot */}
      <div ref={wrapRef} className="relative w-full" style={{ height: h }}>
        {w > 0 && available && candles.length > 0 ? (
          <ChartPlot
            candles={candles}
            w={w}
            hHeight={h}
            hover={hover}
            setHover={setHover}
            chartType={chartType}
            showMa={showMa}
            maShortPeriod={maShortPeriod}
            maLongPeriod={maLongPeriod}
            showVolume={showVolume}
            showRsi={showRsi}
            tool={tool}
            drawings={drawings}
            setDrawings={setDrawings}
            range={range}
            setRange={setRange}
          />
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

function Toolbar({
  chartType,
  setChartType,
  showMa,
  setShowMa,
  maShortPeriod,
  setMaShortPeriod,
  maLongPeriod,
  setMaLongPeriod,
  showVolume,
  setShowVolume,
  showRsi,
  setShowRsi,
  tool,
  setTool,
  hasDrawings,
  onClear,
}: {
  chartType: ChartType;
  setChartType: (t: ChartType) => void;
  showMa: boolean;
  setShowMa: (v: boolean) => void;
  maShortPeriod: number;
  setMaShortPeriod: (n: number) => void;
  maLongPeriod: number;
  setMaLongPeriod: (n: number) => void;
  showVolume: boolean;
  setShowVolume: (v: boolean) => void;
  showRsi: boolean;
  setShowRsi: (v: boolean) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  hasDrawings: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-4 py-1.5 text-xs">
      {/* Chart type */}
      <div className="flex items-center gap-0.5 rounded-full border border-border p-0.5">
        {(["candles", "line"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setChartType(t)}
            className={cn(
              "rounded-full px-2 py-0.5 capitalize transition-colors",
              t === chartType ? "bg-surface-raised text-text-primary" : "text-text-muted hover:text-text-secondary",
            )}
          >
            {t === "candles" ? "Candles" : "Line"}
          </button>
        ))}
      </div>

      {/* Indicators */}
      <div className="flex items-center gap-1.5">
        <IndicatorChip label="MA" active={showMa} onClick={() => setShowMa(!showMa)} title={`${maShortPeriod} and ${maLongPeriod}-period moving average`} />
        {showMa && (
          <span className="flex items-center gap-1 text-[10px] text-text-faint">
            <PeriodInput value={maShortPeriod} onChange={setMaShortPeriod} title="Short MA period" />
            /
            <PeriodInput value={maLongPeriod} onChange={setMaLongPeriod} title="Long MA period" />
          </span>
        )}
        <IndicatorChip label="Vol" active={showVolume} onClick={() => setShowVolume(!showVolume)} title="Volume" />
        <IndicatorChip label="RSI" active={showRsi} onClick={() => setShowRsi(!showRsi)} title="RSI (14)" />
      </div>

      {/* Drawing tools */}
      <div className="ml-auto flex items-center gap-1.5">
        <ToolChip label="Cursor" active={tool === "cursor"} onClick={() => setTool("cursor")} />
        <ToolChip label="H-Line" active={tool === "hline"} onClick={() => setTool("hline")} />
        <ToolChip label="Trend" active={tool === "trend"} onClick={() => setTool("trend")} />
        {hasDrawings && (
          <button onClick={onClear} className="chip chip-neutral hover:text-text-primary">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function IndicatorChip({ label, active, onClick, title }: { label: string; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button title={title} onClick={onClick} className={cn("chip", active ? "chip-accent" : "chip-neutral")}>
      {label}
    </button>
  );
}

function PeriodInput({ value, onChange, title }: { value: number; onChange: (n: number) => void; title?: string }) {
  return (
    <input
      type="number"
      min={1}
      max={300}
      title={title}
      value={value}
      onChange={(e) => {
        const v = parseInt(e.target.value, 10);
        if (Number.isFinite(v)) onChange(clamp(v, 1, 300));
      }}
      className="w-9 rounded border border-border bg-transparent px-1 py-0.5 text-center text-[10px] tabular-nums text-text-secondary"
    />
  );
}

function ToolChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "chip",
        active ? "border border-warning-border bg-warning-bg text-warning" : "chip-neutral",
      )}
    >
      {label}
    </button>
  );
}

function ChartPlot({
  candles,
  w,
  hHeight,
  hover,
  setHover,
  chartType,
  showMa,
  maShortPeriod,
  maLongPeriod,
  showVolume,
  showRsi,
  tool,
  drawings,
  setDrawings,
  range,
  setRange,
}: {
  candles: Candle[];
  w: number;
  hHeight: number;
  hover: number | null;
  setHover: (i: number | null) => void;
  chartType: ChartType;
  showMa: boolean;
  maShortPeriod: number;
  maLongPeriod: number;
  showVolume: boolean;
  showRsi: boolean;
  tool: Tool;
  drawings: Drawing[];
  setDrawings: React.Dispatch<React.SetStateAction<Drawing[]>>;
  range: { start: number; count: number };
  setRange: React.Dispatch<React.SetStateAction<{ start: number; count: number }>>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ pointerId: number; startPx: number; startRangeStart: number } | null>(null);
  const pinchRef = useRef<Map<number, number>>(new Map());
  const pinchBaseRef = useRef<{ dist: number; count: number; start: number } | null>(null);
  const [trendDraft, setTrendDraft] = useState<{ i1: number; p1: number } | null>(null);
  const [trendPreview, setTrendPreview] = useState<{ i2: number; p2: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const n = candles.length;
  const count = range.count > 0 ? Math.min(range.count, n) : n;
  const start = clamp(range.start, 0, Math.max(0, n - count));
  const visible = useMemo(() => candles.slice(start, start + count), [candles, start, count]);

  const plotW = Math.max(1, w - AXIS_W);
  const pricePlotH = PRICE_H - PAD_TOP - PAD_BOTTOM;
  const volTop = PRICE_H + PANEL_GAP;
  const rsiTop = PRICE_H + (showVolume ? PANEL_GAP + VOL_H + PANEL_GAP : PANEL_GAP);

  const vn = visible.length || 1;
  const step = plotW / vn;
  const bodyW = Math.max(1, Math.min(step * 0.62, 14));

  // Price scale — from the VISIBLE window, so panning/zooming rescales the axis
  // the way every real trading chart does.
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of visible) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  const pad = (hi - lo) * 0.06 || hi * 0.06 || 1;
  lo -= pad;
  hi += pad;
  const span = hi - lo || 1;
  const y = (price: number) => PAD_TOP + ((hi - price) / span) * pricePlotH;
  const priceAtY = (py: number) => hi - ((py - PAD_TOP) / pricePlotH) * span;
  const x = (iView: number) => iView * step + step / 2;
  const absToView = (abs: number) => abs - start;

  // Full-series indicators — computed once over ALL candles, then sliced to the
  // visible window, so values don't jump/recompute as you pan (a 7-period MA at
  // candle 500 always reflects candles 494-500, regardless of what's on screen).
  const closes = useMemo(() => candles.map((c) => c.c), [candles]);
  const maShortFull = useMemo(() => (showMa ? sma(closes, maShortPeriod) : []), [closes, showMa, maShortPeriod]);
  const maLongFull = useMemo(() => (showMa ? sma(closes, maLongPeriod) : []), [closes, showMa, maLongPeriod]);
  const rsiFull = useMemo(() => (showRsi ? rsi(closes, 14) : []), [closes, showRsi]);

  const last = candles[n - 1];
  const lastY = last ? y(clamp(last.c, lo, hi)) : 0;
  const lastUp = last ? last.c >= last.o : true;

  const ticks = Array.from({ length: 5 }, (_, i) => lo + (span * i) / 4);

  let volMax = 0;
  if (showVolume) for (const c of visible) if (c.v > volMax) volMax = Math.max(volMax, c.v);

  function pxToIndexView(px: number): number {
    return clamp(Math.floor(px / step), 0, vn - 1);
  }

  function handleTip(clientX: number, clientY: number, iAbs: number, py: number) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const boxW = 168;
    const boxH = 92;
    // Prefer sitting to the right of the cursor; flip to the left when that
    // would run past the chart's own right edge, so the box never overflows
    // the plot's bounding box in either direction.
    const fitsRight = localX + 14 + boxW <= w;
    const rawX = fitsRight ? localX + 14 : localX - boxW - 14;
    const tx = clamp(rawX, 0, Math.max(0, w - boxW));
    const ty = clamp(localY - boxH / 2, 0, Math.max(0, hHeight - boxH));
    setTip({ x: tx, y: ty });
    setHover(iAbs);
    void py;
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px > plotW || py > PRICE_H) return;

    pinchRef.current.set(e.pointerId, px);
    if (pinchRef.current.size === 2) {
      const pts = Array.from(pinchRef.current.values());
      pinchBaseRef.current = { dist: Math.abs((pts[0] ?? 0) - (pts[1] ?? 0)) || 1, count, start };
      panRef.current = null;
      return;
    }

    if (tool === "cursor") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      panRef.current = { pointerId: e.pointerId, startPx: px, startRangeStart: start };
    } else if (tool === "hline") {
      setDrawings((d) => [...d, { type: "hline", price: priceAtY(py) }]);
    } else if (tool === "trend") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const iView = pxToIndexView(px);
      setTrendDraft({ i1: start + iView, p1: priceAtY(py) });
      setTrendPreview(null);
    }
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (pinchRef.current.has(e.pointerId)) pinchRef.current.set(e.pointerId, px);

    // Two-finger pinch zoom.
    if (pinchRef.current.size === 2 && pinchBaseRef.current) {
      const pts = Array.from(pinchRef.current.values());
      const dist = Math.abs((pts[0] ?? 0) - (pts[1] ?? 0)) || 1;
      const factor = pinchBaseRef.current.dist / dist;
      const anchorAbs = pinchBaseRef.current.start + pinchBaseRef.current.count / 2;
      applyZoom(factor, anchorAbs, pinchBaseRef.current.count, pinchBaseRef.current.start);
      return;
    }

    // Pan (drag) with the cursor tool.
    if (panRef.current && panRef.current.pointerId === e.pointerId) {
      const deltaPx = px - panRef.current.startPx;
      const deltaIndex = deltaPx / step;
      const maxStart = Math.max(0, n - count);
      const newStart = clamp(Math.round(panRef.current.startRangeStart - deltaIndex), 0, maxStart);
      setRange((r) => ({ ...r, start: newStart }));
    }

    if (px < 0 || px > plotW || py < 0 || py > PRICE_H) {
      if (!panRef.current) {
        setHover(null);
        setTip(null);
      }
    } else {
      const iView = pxToIndexView(px);
      handleTip(e.clientX, e.clientY, start + iView, py);
      if (tool === "trend" && trendDraft) {
        setTrendPreview({ i2: start + iView, p2: priceAtY(py) });
      }
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    pinchRef.current.delete(e.pointerId);
    if (pinchRef.current.size < 2) pinchBaseRef.current = null;
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null;
    if (tool === "trend" && trendDraft) {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = clamp(e.clientX - rect.left, 0, plotW);
      const py = clamp(e.clientY - rect.top, PAD_TOP, PRICE_H - PAD_BOTTOM);
      const iView = pxToIndexView(px);
      const i2 = start + iView;
      const p2 = priceAtY(py);
      if (i2 !== trendDraft.i1 || p2 !== trendDraft.p1) {
        setDrawings((d) => [...d, { type: "trend", i1: trendDraft.i1, p1: trendDraft.p1, i2, p2 }]);
      }
      setTrendDraft(null);
      setTrendPreview(null);
    }
  }

  function onPointerLeave() {
    setHover(null);
    setTip(null);
  }

  function applyZoom(factor: number, anchorAbs: number, baseCount: number, baseStart: number) {
    const minVisible = Math.max(5, Math.min(20, n));
    const newCount = clamp(Math.round(baseCount * factor), minVisible, n);
    const fraction = baseCount > 0 ? clamp((anchorAbs - baseStart) / baseCount, 0, 1) : 0.5;
    const maxStart = Math.max(0, n - newCount);
    const newStart = clamp(Math.round(anchorAbs - fraction * newCount), 0, maxStart);
    setRange({ start: newStart, count: newCount });
  }

  // Wheel-to-zoom needs a NON-passive listener — React's synthetic onWheel is
  // registered passive by default, so preventDefault() inside it is silently
  // ignored and the page would scroll along with the chart zooming.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      if (px > plotW) return;
      const iView = pxToIndexView(px);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      applyZoom(factor, start + iView, count, start);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotW, step, start, count, n]);

  const readoutC = candles[hover ?? n - 1];

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        width={w}
        height={hHeight}
        className={cn("block", tool !== "cursor" && "cursor-crosshair")}
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        role="img"
        aria-label={`Price chart, ${vn} of ${n} periods visible`}
      >
        {/* ── Price panel ───────────────────────────────────────────────── */}
        {ticks.map((p, i) => (
          <g key={i}>
            <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke={GRID} strokeWidth={1} />
            <text x={plotW + 6} y={y(p) + 3} fontSize={10} fill={AXIS} className="tabular-nums">
              {formatSmallUsd(p)}
            </text>
          </g>
        ))}

        {chartType === "candles" ? (
          visible.map((c, iView) => {
            const up = c.c >= c.o;
            const color = up ? UP : DOWN;
            const cx = x(iView);
            const openY = y(c.o);
            const closeY = y(c.c);
            const top = Math.min(openY, closeY);
            const bh = Math.max(1, Math.abs(closeY - openY));
            const abs = start + iView;
            return (
              <g key={abs} opacity={hover == null || hover === abs ? 1 : 0.55}>
                <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} />
                <rect x={cx - bodyW / 2} y={top} width={bodyW} height={bh} fill={color} />
              </g>
            );
          })
        ) : (
          <LinePath visible={visible} x={x} y={y} />
        )}

        {showMa && <MaLine values={maShortFull} start={start} count={count} x={x} y={y} color={MA_SHORT} />}
        {showMa && <MaLine values={maLongFull} start={start} count={count} x={x} y={y} color={MA_LONG} />}

        {/* Drawings */}
        {drawings.map((d, i) =>
          d.type === "hline" ? (
            <line
              key={i}
              x1={0}
              x2={plotW}
              y1={clamp(y(d.price), PAD_TOP, PRICE_H - PAD_BOTTOM)}
              y2={clamp(y(d.price), PAD_TOP, PRICE_H - PAD_BOTTOM)}
              stroke={WARNING}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          ) : (
            <line
              key={i}
              x1={x(absToView(d.i1))}
              y1={y(d.p1)}
              x2={x(absToView(d.i2))}
              y2={y(d.p2)}
              stroke={WARNING}
              strokeWidth={1.5}
            />
          ),
        )}
        {trendDraft && trendPreview && (
          <line
            x1={x(absToView(trendDraft.i1))}
            y1={y(trendDraft.p1)}
            x2={x(absToView(trendPreview.i2))}
            y2={y(trendPreview.p2)}
            stroke={WARNING}
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        )}

        {/* Hover crosshair spans the full plot height (through subpanels too). */}
        {hover != null && hover >= start && hover < start + count && (
          <line
            x1={x(absToView(hover))}
            x2={x(absToView(hover))}
            y1={0}
            y2={hHeight}
            stroke={AXIS}
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        )}

        {/* Current-price tag */}
        {last && (
          <g>
            <line x1={0} x2={plotW} y1={lastY} y2={lastY} stroke={lastUp ? UP : DOWN} strokeWidth={1} strokeDasharray="1 2" opacity={0.5} />
            <rect x={plotW} y={lastY - 8} width={AXIS_W} height={16} fill={lastUp ? UP : DOWN} rx={2} />
            <text x={plotW + AXIS_W / 2} y={lastY + 3} fontSize={10} fill={GROUND} textAnchor="middle" className="tabular-nums font-semibold">
              {formatSmallUsd(last.c)}
            </text>
          </g>
        )}

        {/* Sparse time axis under the price panel. */}
        {vn > 1 &&
          [0, Math.floor(vn / 2), vn - 1].map((iView) => (
            <text key={iView} x={x(iView)} y={PRICE_H - 6} fontSize={9} fill={AXIS} textAnchor="middle">
              {fmtTime(visible[iView]!.t)}
            </text>
          ))}

        {/* ── Volume subpanel ───────────────────────────────────────────── */}
        {showVolume && (
          <g>
            <line x1={0} x2={plotW} y1={volTop} y2={volTop} stroke={GRID} strokeWidth={1} />
            <text x={plotW + 6} y={volTop + 12} fontSize={9} fill={AXIS}>
              Vol
            </text>
            {visible.map((c, iView) => {
              const up = c.c >= c.o;
              const bh = volMax > 0 ? (c.v / volMax) * (VOL_H - 10) : 0;
              const cx = x(iView);
              return (
                <rect
                  key={start + iView}
                  x={cx - bodyW / 2}
                  y={volTop + VOL_H - bh}
                  width={bodyW}
                  height={Math.max(0, bh)}
                  fill={up ? UP : DOWN}
                  opacity={0.7}
                />
              );
            })}
          </g>
        )}

        {/* ── RSI subpanel ──────────────────────────────────────────────── */}
        {showRsi && (
          <g>
            <line x1={0} x2={plotW} y1={rsiTop} y2={rsiTop} stroke={GRID} strokeWidth={1} />
            {[30, 70].map((lvl) => {
              const ly = rsiTop + RSI_H - (lvl / 100) * (RSI_H - 8) - 4;
              return (
                <g key={lvl}>
                  <line x1={0} x2={plotW} y1={ly} y2={ly} stroke={WARNING} strokeWidth={1} strokeDasharray="2 3" opacity={0.4} />
                  <text x={plotW + 6} y={ly + 3} fontSize={9} fill={AXIS}>
                    {lvl}
                  </text>
                </g>
              );
            })}
            <RsiLine
              values={rsiFull}
              start={start}
              count={count}
              x={x}
              yFor={(v) => rsiTop + RSI_H - (v / 100) * (RSI_H - 8) - 4}
            />
          </g>
        )}
      </svg>

      {readoutC && tip && (hover ?? -1) >= 0 && (
        <div
          className="pointer-events-none absolute z-10 w-[168px] rounded-input border border-border-strong bg-card/95 p-2 text-[11px] shadow-lg"
          style={{ left: tip.x, top: tip.y }}
        >
          <div className="mb-1 text-text-faint">{fmtTime(readoutC.t)}</div>
          <div className="grid grid-cols-2 gap-x-2 tabular-nums">
            <span className="text-text-faint">
              O <span className="text-text-secondary">{formatSmallUsd(readoutC.o)}</span>
            </span>
            <span className="text-text-faint">
              H <span className="text-text-secondary">{formatSmallUsd(readoutC.h)}</span>
            </span>
            <span className="text-text-faint">
              L <span className="text-text-secondary">{formatSmallUsd(readoutC.l)}</span>
            </span>
            <span className="text-text-faint">
              C <span className={readoutC.c >= readoutC.o ? "text-positive" : "text-negative"}>{formatSmallUsd(readoutC.c)}</span>
            </span>
          </div>
          <div className="mt-1 text-text-faint">
            V <span className="text-text-secondary">{formatCompactUsd(readoutC.v)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function LinePath({
  visible,
  x,
  y,
}: {
  visible: Candle[];
  x: (iView: number) => number;
  y: (close: number) => number;
}) {
  if (visible.length === 0) return null;
  const points = visible.map((c, i) => `${x(i)},${y(c.c)}`).join(" L ");
  const first = visible[0]!;
  const lastX = x(visible.length - 1);
  const firstX = x(0);
  const baseY = PRICE_H - PAD_BOTTOM;
  const areaId = "terminal-line-fill";
  return (
    <>
      <defs>
        <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={UP} stopOpacity={0.22} />
          <stop offset="100%" stopColor={UP} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`M ${firstX},${y(first.c)} L ${points} L ${lastX},${baseY} L ${firstX},${baseY} Z`} fill={`url(#${areaId})`} stroke="none" />
      <path d={`M ${points}`} fill="none" stroke={UP} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </>
  );
}

function MaLine({
  values,
  start,
  count,
  x,
  y,
  color,
}: {
  values: (number | undefined)[];
  start: number;
  count: number;
  x: (iView: number) => number;
  y: (price: number) => number;
  color: string;
}) {
  const segments: string[] = [];
  let current: string[] = [];
  for (let iView = 0; iView < count; iView++) {
    const v = values[start + iView];
    if (v === undefined) {
      if (current.length > 1) segments.push(current.join(" L "));
      current = [];
      continue;
    }
    current.push(`${x(iView)},${y(v)}`);
  }
  if (current.length > 1) segments.push(current.join(" L "));
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((d, i) => (
        <path key={i} d={`M ${d}`} fill="none" stroke={color} strokeWidth={1.3} />
      ))}
    </>
  );
}

function RsiLine({
  values,
  start,
  count,
  x,
  yFor,
}: {
  values: (number | undefined)[];
  start: number;
  count: number;
  x: (iView: number) => number;
  yFor: (v: number) => number;
}) {
  const segments: string[] = [];
  let current: string[] = [];
  for (let iView = 0; iView < count; iView++) {
    const v = values[start + iView];
    if (v === undefined) {
      if (current.length > 1) segments.push(current.join(" L "));
      current = [];
      continue;
    }
    current.push(`${x(iView)},${yFor(v)}`);
  }
  if (current.length > 1) segments.push(current.join(" L "));
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((d, i) => (
        <path key={i} d={`M ${d}`} fill="none" stroke={RSI_LINE} strokeWidth={1.3} />
      ))}
    </>
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
