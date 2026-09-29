"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Address } from "viem";
import { createChart, AreaSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useOhlcv } from "@/hooks/useOhlcv";
import { sanitizeCandles } from "@/lib/market";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Chrome-free inline sparkline for a Discover/Top-Movers row — same real data
// (GeckoTerminal OHLCV via useOhlcv) and the same draw-in-on-load spirit as the
// full token-page chart, scaled down to a line with no axes, grid, or labels
// (sparkline convention; CLAUDE.md "cards contain zero sentences" — this is a
// number, not a caption). Renders a blank slot when there's no real series yet,
// never a flat placeholder line.
const UP = "#22C93A";
const DOWN = "#E2564D";

export function Sparkline(props: { token: Address; width?: number; height?: number }) {
  return (
    <ErrorBoundary fallback={<div style={{ width: props.width ?? 64, height: props.height ?? 24 }} aria-hidden className="shrink-0" />}>
      <SparklineInner {...props} />
    </ErrorBoundary>
  );
}

function SparklineInner({ token, width = 64, height = 24 }: { token: Address; width?: number; height?: number }) {
  const { ohlcv, available } = useOhlcv(token, "15m");
  const candles = useMemo(() => sanitizeCandles(ohlcv?.candles ?? []), [ohlcv?.candles]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const lastTickRef = useRef<{ t: number; c: number } | null>(null);
  const upRef = useRef<boolean | null>(null);

  // Create the chart + a single area series once. Color direction is updated in
  // place via applyOptions as real data arrives, never by tearing the chart down.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width,
      height,
      layout: { background: { color: "transparent" }, textColor: "transparent", attributionLogo: false },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { horzLine: { visible: false }, vertLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: UP,
      topColor: "rgba(34,201,58,0.2)",
      bottomColor: "rgba(34,201,58,0)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [width, height]);

  // Feed real candles in: full setData on first arrival (or a series length
  // change), otherwise update() the trailing point only — no flicker on a poll.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || candles.length === 0) return;

    const last = candles[candles.length - 1]!;
    const first = candles[0]!;
    const up = last.c >= first.c;
    if (upRef.current !== up) {
      upRef.current = up;
      const color = up ? UP : DOWN;
      series.applyOptions({
        lineColor: color,
        topColor: up ? "rgba(34,201,58,0.2)" : "rgba(226,86,77,0.2)",
        bottomColor: up ? "rgba(34,201,58,0)" : "rgba(226,86,77,0)",
      });
    }

    const prev = lastTickRef.current;
    if (!prev || prev.t !== last.t) {
      series.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, value: c.c })));
      chart.timeScale().fitContent();
    } else if (prev.c !== last.c) {
      series.update({ time: last.t as UTCTimestamp, value: last.c });
    }
    lastTickRef.current = { t: last.t, c: last.c };
  }, [candles]);

  return (
    <div
      ref={wrapRef}
      style={{ width, height, visibility: available && candles.length > 1 ? "visible" : "hidden" }}
      aria-hidden
      className="shrink-0"
    />
  );
}
