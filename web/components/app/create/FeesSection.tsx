"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { cn } from "@/lib/cn";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";
import { useProjects } from "@/hooks/useProjects";
import { useProjectsMeta } from "@/hooks/useProjectMeta";
import { AssetDisc } from "@/components/app/AssetDisc";
import { WETH_ADDRESS, isHiddenToken, isRetiredToken } from "@/lib/contracts";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress } from "@/lib/format";

type ParentOption = { token: Address; symbol?: string; name?: string; metadataURI?: string; label: string };

const BPS = 10000;

type PresetKey = "creator" | "treasury" | "buyback" | "rewards" | "custom";

const PRESETS: { key: PresetKey; label: string; split: FeeSplitBps; disabled?: boolean }[] = [
  { key: "creator", label: "All to me", split: { creatorBps: BPS, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 } },
  { key: "treasury", label: "Grow treasury", split: { creatorBps: 0, treasuryBps: BPS, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 }, disabled: true },
  { key: "buyback", label: "Buyback & burn", split: { creatorBps: 0, treasuryBps: 0, buybackBps: BPS, parentBurnBps: 0, rewardsBps: 0 } },
  { key: "rewards", label: "Reward stakers", split: { creatorBps: 0, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: BPS } },
  { key: "custom", label: "Custom", split: { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, parentBurnBps: 0, rewardsBps: 2500 } },
];

const BUCKETS: { key: keyof Omit<FeeSplitBps, "parent">; label: string; color: string; disabled?: boolean; requiresParent?: boolean }[] = [
  { key: "creatorBps", label: "Creator", color: "bg-green" },
  { key: "treasuryBps", label: "Treasury", color: "bg-bone/30", disabled: true },
  { key: "buybackBps", label: "Buyback & burn", color: "bg-warning" },
  { key: "parentBurnBps", label: "Parent burn", color: "bg-negative", requiresParent: true },
  { key: "rewardsBps", label: "Stakers", color: "bg-accent" },
];

/**
 * Where a launch's trading fees go, in bps across up to five buckets (sum 10000,
 * default 100% creator — matches FeeRouter's own default). The treasury bucket is
 * disabled here: its swap needs a verified WETH/asset pool key
 * (docs/FEE_ROUTER_DESIGN.md §2.4) that isn't resolvable client-side yet. The
 * parentBurn bucket (v2 only, `allowParent`) requires picking a family parent — a
 * Ballast-launched token with a live WETH pool. Selecting anything other than "All
 * to me" routes the launch through the FeeRouter factory instead of calling
 * BallastFactory.launch() directly — see useFeeRouterLaunchRunner.
 */
export function FeesSection({
  split,
  onChange,
  allowParent,
  lockParent,
  thisTokenSymbol,
}: {
  split: FeeSplitBps;
  onChange: (s: FeeSplitBps) => void;
  allowParent: boolean; // v2 active → the parentBurn bucket + parent picker are available
  lockParent?: boolean; // parent is already fixed (dashboard: it's immutable) — hide the picker, keep the bucket
  thisTokenSymbol?: string;
}) {
  const [preset, setPreset] = useState<PresetKey>("creator");
  const { projects } = useProjects();

  // Candidate parents: Ballast-launched tokens with a live WETH pool. The contract
  // re-validates (NotBallastParent / ParentPoolNotReady), so this is UX-only.
  // Deduped by token address (case-insensitive) so a token can never appear twice
  // in the picker (e.g. the same address surfaced once with mixed casing).
  const parentOptions = useMemo<ParentOption[]>(() => {
    if (!allowParent) return [];
    const weth = WETH_ADDRESS?.toLowerCase();
    const seen = new Set<string>();
    const out: ParentOption[] = [];
    for (const p of projects) {
      if (isHiddenToken(p.token) || isRetiredToken(p.token) || !p.hasPool) continue;
      if (weth && !p.quoteAssets.some((q) => q.toLowerCase() === weth)) continue;
      const key = p.token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        token: p.token,
        symbol: p.symbol,
        name: p.name,
        metadataURI: p.metadataURI,
        label: p.symbol ? `$${p.symbol}` : shortAddress(p.token),
      });
    }
    return out;
  }, [projects, allowParent]);

  const visibleBuckets = BUCKETS.filter((b) => !b.requiresParent || (allowParent && Boolean(split.parent)));

  function applyPreset(p: (typeof PRESETS)[number]) {
    if (p.disabled) return;
    setPreset(p.key);
    onChange({ ...p.split, parent: split.parent });
  }

  function setBucket(key: keyof Omit<FeeSplitBps, "parent">, value: number) {
    setPreset("custom");
    // Clamp the dragged slider so the OTHER non-creator buckets it isn't touching
    // still fit within 100%, then absorb whatever's left into "Creator" — this can
    // never go negative, so every reachable slider position is a valid split.
    const otherBuckets = (["treasuryBps", "buybackBps", "parentBurnBps", "rewardsBps"] as const).filter((k) => k !== key);
    const othersTotal = otherBuckets.reduce((sum, k) => sum + split[k], 0);
    const clamped = Math.min(value, BPS - othersTotal);
    onChange({ ...split, [key]: clamped, creatorBps: BPS - othersTotal - clamped });
  }

  function setParent(token: Address | undefined) {
    if (!token) {
      // Clearing the parent zeroes the parentBurn bucket and hands it back to creator.
      onChange({ ...split, parent: undefined, creatorBps: split.creatorBps + split.parentBurnBps, parentBurnBps: 0 });
      return;
    }
    onChange({ ...split, parent: token });
  }

  const total = split.creatorBps + split.treasuryBps + split.buybackBps + split.parentBurnBps + split.rewardsBps;

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p)}
            disabled={p.disabled}
            className={cn("tab", preset === p.key ? "tab-active" : "tab-idle", p.disabled && "cursor-not-allowed opacity-40")}
            title={p.disabled ? "Coming soon" : undefined}
          >
            {p.label}
            {p.disabled && <span className="ml-1 text-text-faint">·soon</span>}
          </button>
        ))}
      </div>

      {/* Live split preview — segments, labels + percentages only. */}
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised">
        {visibleBuckets.map((b) => {
          const pct = split[b.key] / 100;
          if (pct <= 0) return null;
          return <div key={b.key} className={cn(b.color, "h-full")} style={{ width: `${pct}%` }} />;
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {visibleBuckets.map((b) => (
          <div key={b.key} className={cn("flex items-center gap-1.5", b.disabled && "opacity-40")}>
            <span className={cn("h-2 w-2 shrink-0 rounded-full", b.color)} />
            <span className="min-w-0 truncate text-text-secondary">{b.label}</span>
            <span className="ml-auto shrink-0 font-mono text-text-primary">{(split[b.key] / 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>

      {/* Family parent picker (v2). Selecting one unlocks the Parent burn bucket.
          Hidden when the parent is already fixed (dashboard: immutable on-chain). */}
      {allowParent && !lockParent && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="section-label">Parent token</span>
            <span className="text-xs text-text-faint">optional · for token families</span>
          </div>
          <ParentTokenCombobox
            options={parentOptions}
            value={split.parent}
            onChange={setParent}
          />
          {split.parent && (
            <p className="text-xs text-text-faint">
              A share of this token&apos;s creator fees buys {parentOptions.find((o) => o.token === split.parent)?.label ?? "$PARENT"} and
              sends it to the dead address.
            </p>
          )}
        </div>
      )}

      {preset === "custom" && (
        <div className="space-y-3 border-t border-border pt-3">
          {visibleBuckets.filter((b) => !b.disabled).map((b) => (
            <label key={b.key} className="block">
              <div className="mb-1 flex justify-between text-xs text-text-secondary">
                <span>{b.label}</span>
                <span className="font-mono">{(split[b.key] / 100).toFixed(0)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={BPS}
                step={100}
                value={split[b.key]}
                onChange={(e) => setBucket(b.key, Number(e.target.value))}
                className="w-full"
              />
            </label>
          ))}
        </div>
      )}

      {total !== BPS && <p className="text-xs text-negative">Split must sum to 100% (currently {(total / 100).toFixed(0)}%).</p>}

      {preset !== "creator" && (
        <p className="text-xs text-text-faint">
          Your creator fees go to a FeeRouter contract for this token, which splits them on-chain by these percentages.{" "}
          {allowParent
            ? "Lowering your own share applies instantly. Anything else takes effect 7 days after you schedule it."
            : "Changes take effect 7 days after you schedule them."}
          {thisTokenSymbol ? ` Staking rewards are paid in WETH, can be zero.` : ""}
        </p>
      )}
    </section>
  );
}

// Searchable parent-token picker with logos — replaces a bare <select> so a long
// token list is filterable by ticker / name / address and each row shows the
// token's own pinned logo (reuses AssetDisc + the same substring-match pattern as
// CommandSearch). Options arrive already deduped by address from parentOptions.
function ParentTokenCombobox({
  options,
  value,
  onChange,
}: {
  options: ParentOption[];
  value?: Address;
  onChange: (token: Address | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Resolve each candidate's pinned logo (token address → gateway URL).
  const metaByToken = useProjectsMeta(options);
  const logoFor = (token: Address) => ipfsToGateway(metaByToken.get(token.toLowerCase())?.logo);

  const selected = value ? options.find((o) => o.token.toLowerCase() === value.toLowerCase()) : undefined;

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter(
      (o) =>
        o.token.toLowerCase().includes(s) ||
        (o.symbol ?? "").toLowerCase().includes(s) ||
        (o.name ?? "").toLowerCase().includes(s),
    );
  }, [options, q]);

  // Close on outside click / Escape; focus the search field on open.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(token: Address | undefined) {
    onChange(token);
    setOpen(false);
    setQ("");
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="input flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            <>
              <AssetDisc src={logoFor(selected.token)} symbol={selected.symbol} size={22} />
              <span className="truncate text-text-primary">{selected.label}</span>
            </>
          ) : (
            <span className="text-text-faint">None</span>
          )}
        </span>
        <span aria-hidden className="shrink-0 text-text-faint">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-input border border-border bg-card shadow-lg">
          <div className="border-b border-border p-2">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search ticker, name, or address"
              spellCheck={false}
              autoComplete="off"
              className="w-full bg-transparent px-1 py-1.5 text-sm text-text-primary placeholder:text-text-faint focus:outline-none"
            />
          </div>
          <ul role="listbox" className="max-h-64 overflow-y-auto p-1">
            <li>
              <button
                type="button"
                onClick={() => pick(undefined)}
                className={cn(
                  "flex min-h-[44px] w-full items-center gap-2 rounded-input px-2 text-left text-sm transition-colors hover:bg-surface-raised",
                  !value && "bg-surface-raised",
                )}
              >
                <span className="text-text-secondary">None</span>
              </button>
            </li>
            {filtered.map((o) => (
              <li key={o.token}>
                <button
                  type="button"
                  onClick={() => pick(o.token)}
                  className={cn(
                    "flex min-h-[44px] w-full items-center gap-2 rounded-input px-2 text-left transition-colors hover:bg-surface-raised",
                    value?.toLowerCase() === o.token.toLowerCase() && "bg-surface-raised",
                  )}
                >
                  <AssetDisc src={logoFor(o.token)} symbol={o.symbol} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text-primary">{o.label}</span>
                    {o.name && <span className="block truncate text-xs text-text-muted">{o.name}</span>}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-2 py-3 text-center text-sm text-text-muted">No tokens match.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
