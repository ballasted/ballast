"use client";

import { useState } from "react";
import {
  AddressPill,
  Card,
  Chip,
  DeltaText,
  Segmented,
  Skeleton,
  Stat,
  Tag,
  useCountUp,
  type TagTone,
} from "@/components/ui";
import { TokenAmount } from "@/components/app/TokenAmount";
import { formatUsd } from "@/lib/format";

const NEW_SWATCHES: Array<{ label: string; className: string; note: string }> = [
  { label: "up", className: "bg-up", note: "#3BE070 — price up" },
  { label: "down", className: "bg-down", note: "#FF6464 — price down" },
  { label: "backing", className: "bg-backing", note: "#E9B44C — treasury backing" },
  { label: "burn", className: "bg-burn", note: "#FF8A2B — buyback & burn" },
  { label: "creator-accent", className: "bg-creator-accent", note: "#7FB3FF — creator side" },
  { label: "staked", className: "bg-staked", note: "#C792EA — stakers" },
];

const TAG_TONES: TagTone[] = ["neutral", "green", "backing", "burn", "creator", "staked", "negative"];

const SAMPLE_ADDR = "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C";

export function UiOverhaulShowcase() {
  const [tf, setTf] = useState<"5m" | "1h" | "4h" | "1D" | "All">("4h");
  const [mode, setMode] = useState<"line" | "candles">("candles");
  const [overlays, setOverlays] = useState<Record<string, boolean>>({ backing: true, burns: true });
  const mcap = useCountUp(43234);

  return (
    <div className="space-y-8">
      {/* Semantic swatches + radii */}
      <div>
        <p className="eyebrow mb-3">Semantic palette (additive)</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {NEW_SWATCHES.map((s) => (
            <Card key={s.label} padded={false} className="p-3">
              <div className={`h-14 w-full rounded-chip ${s.className}`} />
              <div className="mt-2 font-mono text-ui-xs text-text-primary">{s.label}</div>
              <div className="text-ui-xs text-text-muted">{s.note}</div>
            </Card>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-6">
          <div className="flex flex-col items-center gap-2">
            <div className="h-16 w-24 rounded-card-lg border border-hairline bg-card" />
            <span className="font-mono text-ui-xs text-text-muted">rounded-card-lg · 20px</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div className="h-10 w-24 rounded-chip border border-hairline bg-card" />
            <span className="font-mono text-ui-xs text-text-muted">rounded-chip · 10px</span>
          </div>
        </div>
      </div>

      {/* Card + Segmented + Chip */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="eyebrow mb-3">Segmented</p>
          <div className="flex flex-wrap gap-3">
            <Segmented
              ariaLabel="Timeframe"
              value={tf}
              onChange={setTf}
              options={[
                { value: "5m", label: "5m" },
                { value: "1h", label: "1h" },
                { value: "4h", label: "4h" },
                { value: "1D", label: "1D" },
                { value: "All", label: "All" },
              ]}
            />
            <Segmented
              size="sm"
              ariaLabel="Chart mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "line", label: "Line" },
                { value: "candles", label: "Candles" },
              ]}
            />
          </div>
          <p className="mt-4 eyebrow mb-2">Chips (toggle)</p>
          <div className="flex flex-wrap gap-2">
            {["backing", "burns"].map((k) => (
              <Chip
                key={k}
                active={overlays[k]}
                onClick={() => setOverlays((o) => ({ ...o, [k]: !o[k] }))}
              >
                {k[0]!.toUpperCase() + k.slice(1)}
              </Chip>
            ))}
          </div>
          <p className="mt-4 eyebrow mb-2">Tags</p>
          <div className="flex flex-wrap gap-2">
            {TAG_TONES.map((t) => (
              <Tag key={t} tone={t}>
                {t}
              </Tag>
            ))}
          </div>
          <p className="mt-4 eyebrow mb-2">AddressPill</p>
          <div className="flex flex-wrap gap-2">
            <AddressPill address={SAMPLE_ADDR} prefix="by" />
            <AddressPill address={SAMPLE_ADDR} label="Dead address" />
          </div>
        </Card>

        <Card>
          <p className="eyebrow mb-3">Stat · DeltaText · CountUp</p>
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="Market cap"
              value={formatUsd(BigInt(Math.round(mcap)) * 10n ** 18n, { compact: true })}
              sub={<DeltaText value={-4.1} suffix="% 24h" />}
            />
            <Stat
              label="24h volume"
              value={formatUsd(10_100n * 10n ** 18n, { compact: true })}
              sub={<DeltaText value={18} suffix="% 7d" />}
            />
            <Stat label="You receive" value={<TokenAmount value={2_610_000n * 10n ** 18n} symbol="BALLAST" />} />
            <Stat label="Holders" value="149" sub="+6 today" />
          </div>
          <p className="mt-4 eyebrow mb-2">DeltaText states</p>
          <div className="flex flex-wrap gap-4 text-ui-md">
            <DeltaText value={12.4} />
            <DeltaText value={-4.1} />
            <DeltaText value={0} />
            <DeltaText value={null} />
          </div>
          <p className="mt-4 eyebrow mb-2">Skeleton (loading, never an empty box)</p>
          <div className="space-y-2">
            <Skeleton height={28} width="60%" />
            <Skeleton height={14} width="90%" />
            <Skeleton height={14} width="75%" />
          </div>
        </Card>
      </div>
    </div>
  );
}
