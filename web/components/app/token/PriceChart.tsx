"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import {
  createChart,
  AreaSeries,
  CandlestickSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useOhlcv } from "@/hooks/useOhlcv";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { Freshness } from "@/components/app/Freshness";
import { formatSmallUsd, type Candle, type Timeframe } from "@/lib/market";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

// The default token-page price chart — replaces the hand-rolled SVG chart that
// used to sit here (TerminalChart stays exactly as it was, now used ONLY by the
// dedicated /app/terminal pro view). Built on lightweight-charts so pan/zoom,
// crosshair, and redraw-free live updates come from a maintained renderer
// instead of bespoke pointer math. Candles are the same GeckoTerminal series the
// rest of the app already reads (useOhlcv → /api/ohlcv) — real trade data only;
// an unindexed pool renders an honest empty state, never a fabricated line.
const UP = "#22C93A"; // green
const DOWN = "#E2564D"; // negative
const GRID = "rgba(245,243,236,0.06)";
const AXIS = "rgba(245,243,236,0.38)";
const AXIS_STRONG = "rgba(245,243,236,0.62)";

type ChartKind = "line" | "candles";
type ChartTf = "1H" | "1D" | "1W" | "All";
type Unit = "usd" | "quote";

// Maps the token page's simple timeframe pills onto the granularities the
// shared /api/ohlcv proxy already serves (lib/market.ts TIMEFRAMES, owned by the
// terminal chart's own pill row) plus a client-side lookback window. Not adding
// new keys to that shared table — it would also grow the terminal's own
// timeframe row, which isn't this component's to change.
const TF_MAP: Record<ChartTf, { tf: Timeframe; windowCount?: number }> = {
  "1H": { tf: "1m", windowCount: 60 },
  "1D": { tf: "15m", windowCount: 96 },
  "1W": { tf: "1h", windowCount: 168 },
  All: { tf: "1d" },
};
const TF_ORDER: ChartTf[] = ["1H", "1D", "1W", "All"];

function fmtTooltipTime(t: number): string {
  return new Date(t * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatQuoteUnit(n: number, symbol: string): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return `${n.toFixed(digits)} ${symbol}`;
}

// requestAnimationFrame ease-out tween for the headline price — the "counts up/
// down to the new value" requirement. Snaps instantly under reduced motion or on
// the very first value (nothing to tween FROM yet).
function useTweenedNumber(target: number | undefined, reduced: boolean, durationMs = 450): number | undefined {
  const [display, setDisplay] = useState<number | undefined>(target);
  const fromRef = useRef<number | undefined>(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === undefined) {
      fromRef.current = undefined;
      setDisplay(undefined);
      return;
    }
    if (reduced || fromRef.current === undefined) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (target - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, reduced, durationMs]);

  return display;
}

export function PriceChart({
  token,
  quoteSymbol,
  quoteUsdPrice,
  livePriceUsd,
  className,
}: {
  token: Address;
  /** Ticker of the pool's non-WETH quote asset (e.g. "NVDA"), only when it's a
   *  live-priced allowlisted asset — enables the USD/quote-asset unit switch. */
  quoteSymbol?: string;
  /** Live USD price of 1 unit of that quote asset (from its own Chainlink feed,
   *  read elsewhere via useAssets — never re-derived here). */
  quoteUsdPrice?: number;
  /** Most-recently-known real USD price of the token (on-chain or GeckoTerminal,
   *  whichever the caller already has) — refreshed faster than the OHLCV proxy's
   *  60s poll, so the headline readout can move between candle refetches without
   *  ever inventing a point that isn't backed by a real read. */
  livePriceUsd?: number;
  className?: string;
}) {
  const [tfKey, setTfKey] = useState<ChartTf>("1D");
  const [kind, setKind] = useState<ChartKind>("line");
  const [unit, setUnit] = useState<Unit>("usd");
  const reduced = useReducedMotion();

  const canUseQuoteUnit = quoteSymbol !== undefined && quoteUsdPrice !== undefined && quoteUsdPrice > 0;
  useEffect(() => {
    if (!canUseQuoteUnit && unit === "quote") setUnit("usd");
  }, [canUseQuoteUnit, unit]);

  const { tf, windowCount } = TF_MAP[tfKey];
  const { ohlcv, isLoading, available } = useOhlcv(token, tf);
  const candlesAll = ohlcv?.candles ?? [];
  const candles = useMemo(
    () => (windowCount ? candlesAll.slice(-windowCount) : candlesAll),
    [candlesAll, windowCount],
  );
  const candlesByTime = useMemo(() => new Map(candles.map((c) => [c.t, c] as const)), [candles]);

  const toUnit = (usd: number) => (unit === "quote" && quoteUsdPrice ? usd / quoteUsdPrice : usd);
  // Format a raw USD candle value in whichever unit is currently selected — the
  // ONE place that decides between "$x.xx" and "x.xx SYMBOL", so the header,
  // tooltip, and OHLC readout can never disagree about which unit is on screen.
  const fmtPrice = (usd: number) => (unit === "usd" ? formatSmallUsd(usd) : formatQuoteUnit(toUnit(usd), quoteSymbol!));

  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const resetKeyRef = useRef<string>("");
  const lastTickRef = useRef<{ t: number; c: number } | null>(null);

  const [burst, setBurst] = useState<{ nonce: number; up: boolean } | null>(null);
  const [dotPos, setDotPos] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; candle: Candle } | null>(null);
  const [revealed, setRevealed] = useState(false);

  // ── Create the chart once, tear down on unmount. ──────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: { background: { color: "transparent" }, textColor: AXIS, fontSize: 11 },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: GRID },
      timeScale: { borderColor: GRID, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: AXIS_STRONG, width: 1, style: 3, labelBackgroundColor: "#131B16" },
        horzLine: { color: AXIS_STRONG, width: 1, style: 3, labelBackgroundColor: "#131B16" },
      },
      handleScroll: false,
      handleScale: false,
      autoSize: true,
    });
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Crosshair subscription is separate from chart creation (above) so it can be
  // re-subscribed whenever the candle lookup table changes, without tearing down
  // and recreating the whole chart (which would also drop the series) on every
  // data refresh.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (param: MouseEventParams<Time>) => {
      if (!param.point || param.time === undefined) {
        setHover(null);
        return;
      }
      const candle = candlesByTime.get(param.time as unknown as number);
      setHover(candle ? { x: param.point.x, y: param.point.y, candle } : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [candlesByTime]);

  // ── (Re)create the series when the chart type changes. ────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (seriesRef.current) {
      chart.removeSeries(seriesRef.current);
      seriesRef.current = null;
    }
    if (kind === "line") {
      seriesRef.current = chart.addSeries(AreaSeries, {
        lineColor: UP,
        topColor: "rgba(34,201,58,0.28)",
        bottomColor: "rgba(34,201,58,0)",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: UP,
        crosshairMarkerBackgroundColor: "#0E1410",
      });
    } else {
      seriesRef.current = chart.addSeries(CandlestickSeries, {
        upColor: UP,
        downColor: DOWN,
        borderVisible: false,
        wickUpColor: UP,
        wickDownColor: DOWN,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    }
    resetKeyRef.current = ""; // force a full setData on the next data effect run
  }, [kind]);

  // ── Push data in: full setData on a structural reset (timeframe/kind/unit
  // change), otherwise series.update() for just the trailing bar so a live poll
  // never re-renders the whole chart (60fps target, no flicker). ─────────────
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || candles.length === 0) return;

    const resetKey = `${tfKey}:${kind}:${unit}`;
    const isFresh = resetKeyRef.current !== resetKey;
    const last = candles[candles.length - 1]!;
    const prevTick = lastTickRef.current;

    const point = (c: Candle) =>
      kind === "line"
        ? { time: c.t as UTCTimestamp, value: toUnit(c.c) }
        : { time: c.t as UTCTimestamp, open: toUnit(c.o), high: toUnit(c.h), low: toUnit(c.l), close: toUnit(c.c) };

    if (isFresh) {
      if (kind === "line") {
        (series as ISeriesApi<"Area">).setData(candles.map(point) as { time: UTCTimestamp; value: number }[]);
      } else {
        (series as ISeriesApi<"Candlestick">).setData(
          candles.map(point) as { time: UTCTimestamp; open: number; high: number; low: number; close: number }[],
        );
      }
      chart.timeScale().fitContent();
      resetKeyRef.current = resetKey;
      setRevealed(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setRevealed(true)));
    } else {
      if (kind === "line") {
        (series as ISeriesApi<"Area">).update(point(last) as { time: UTCTimestamp; value: number });
      } else {
        (series as ISeriesApi<"Candlestick">).update(
          point(last) as { time: UTCTimestamp; open: number; high: number; low: number; close: number },
        );
      }
      if (prevTick && (prevTick.t !== last.t || prevTick.c !== last.c) && !reduced) {
        setBurst({ nonce: Date.now(), up: last.c >= prevTick.c });
      }
    }
    lastTickRef.current = { t: last.t, c: last.c };

    const x = chart.timeScale().timeToCoordinate(last.t as UTCTimestamp);
    const y = series.priceToCoordinate(toUnit(last.c));
    if (x !== null && y !== null) setDotPos({ x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, kind, unit, tfKey]);

  useEffect(() => {
    if (!burst) return;
    const id = setTimeout(() => setBurst(null), 800);
    return () => clearTimeout(id);
  }, [burst]);

  // ── Headline readout: prefer the caller's faster-refreshed live price, fall
  // back to the last fetched candle's close. Both are real reads, never a guess. ─
  const lastCandle = candles[candles.length - 1];
  const currentUsd = livePriceUsd ?? lastCandle?.c;
  const displayValue = useTweenedNumber(currentUsd !== undefined ? toUnit(currentUsd) : undefined, reduced);

  const firstCandle = candles[0];
  const changePct =
    firstCandle && firstCandle.o > 0 && currentUsd !== undefined ? ((currentUsd - firstCandle.o) / firstCandle.o) * 100 : undefined;
  const up = (changePct ?? 0) >= 0;

  // displayValue is already toUnit()-converted (tweened from that space, so the
  // animation eases in whichever unit is currently selected); format directly
  // rather than through fmtPrice, which expects a raw USD input.
  const priceLabel =
    displayValue === undefined ? "—" : unit === "usd" ? formatSmallUsd(displayValue) : formatQuoteUnit(displayValue, quoteSymbol!);

  if (isLoading && candles.length === 0) {
    return (
      <section className={cn("card overflow-hidden p-0", className)}>
        <div className="h-[340px] animate-pulse bg-surface-raised" />
      </section>
    );
  }

  if (!available || candles.length === 0) {
    return (
      <section className={cn("card overflow-hidden p-5", className)}>
        <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
          <Meander className="mb-4 max-w-[100px] opacity-60" />
          <p className="text-sm text-text-muted">
            {ohlcv?.reason === "unreachable" ? "Price history unavailable" : "No trades yet"}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className={cn("card overflow-hidden p-0", className)}>
      {/* Header: tweened price · animated % pill · freshness. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2.5">
          <span className="figure-primary text-2xl tabular-nums">{priceLabel}</span>
          {changePct !== undefined && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums transition-colors duration-300",
                up ? "bg-green-bg text-green" : "bg-negative/10 text-negative",
              )}
            >
              {up ? "▲" : "▼"} {Math.abs(changePct).toFixed(2)}%
            </span>
          )}
        </div>
        <Freshness updatedAt={ohlcv?.fetchedAt} source={ohlcv?.source ?? "GeckoTerminal"} unavailable={!available} />
      </div>

      {/* Toolbar: chart type · unit switch · timeframe. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Pills
            value={kind}
            onChange={setKind}
            options={[
              { key: "line", label: "Line" },
              { key: "candles", label: "Candles" },
            ]}
          />
          {canUseQuoteUnit && (
            <Pills
              value={unit}
              onChange={setUnit}
              options={[
                { key: "usd", label: "USD" },
                { key: "quote", label: quoteSymbol! },
              ]}
            />
          )}
        </div>
        <Pills value={tfKey} onChange={setTfKey} options={TF_ORDER.map((k) => ({ key: k, label: k }))} />
      </div>

      {/* Plot. Clip-path wipes in left-to-right on first paint / structural
          reset; the global prefers-reduced-motion rule collapses the
          transition duration to ~0, so this becomes an instant show. */}
      <div
        className="relative h-[300px] w-full"
        style={{
          clipPath: revealed ? "inset(0 0% 0 0)" : "inset(0 100% 0 0)",
          transition: "clip-path 900ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div ref={wrapRef} className="h-full w-full" />

        {burst && dotPos && (
          <div key={burst.nonce} aria-hidden className="pointer-events-none absolute z-10" style={{ left: dotPos.x - 6, top: dotPos.y - 6 }}>
            <span className={cn("tick-burst absolute h-3 w-3 rounded-full border-2", burst.up ? "border-positive" : "border-negative")} />
            <span
              className={cn("tick-burst-delay absolute h-3 w-3 rounded-full border-2", burst.up ? "border-positive" : "border-negative")}
            />
          </div>
        )}

        {dotPos && (
          <span
            aria-hidden
            className={cn("pointer-events-none absolute z-10 h-2 w-2 rounded-full", up ? "bg-green" : "bg-negative")}
            style={{ left: dotPos.x - 4, top: dotPos.y - 4, boxShadow: `0 0 8px 1px ${up ? UP : DOWN}` }}
          />
        )}

        {hover && (
          <div
            className="pointer-events-none absolute z-20 w-[168px] rounded-input border border-border-strong bg-card/95 p-2 text-[11px] shadow-lg"
            style={{
              left: Math.min(Math.max(0, hover.x + 12), 999),
              top: Math.max(0, hover.y - 60),
            }}
          >
            <div className="mb-1 text-text-faint">{fmtTooltipTime(hover.candle.t)}</div>
            {kind === "candles" ? (
              <div className="grid grid-cols-2 gap-x-2 tabular-nums">
                <span className="text-text-faint">
                  O <span className="text-text-secondary">{fmtPrice(hover.candle.o)}</span>
                </span>
                <span className="text-text-faint">
                  H <span className="text-text-secondary">{fmtPrice(hover.candle.h)}</span>
                </span>
                <span className="text-text-faint">
                  L <span className="text-text-secondary">{fmtPrice(hover.candle.l)}</span>
                </span>
                <span className="text-text-faint">
                  C{" "}
                  <span className={hover.candle.c >= hover.candle.o ? "text-positive" : "text-negative"}>
                    {fmtPrice(hover.candle.c)}
                  </span>
                </span>
              </div>
            ) : (
              <div className="tabular-nums text-text-secondary">{fmtPrice(hover.candle.c)}</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Pills<K extends string>({
  value,
  onChange,
  options,
}: {
  value: K;
  onChange: (v: K) => void;
  options: { key: K; label: string }[];
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "rounded-full px-2 py-0.5 text-xs tabular-nums transition-colors",
            o.key === value ? "bg-green text-bg font-semibold" : "text-text-muted hover:text-text-secondary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
