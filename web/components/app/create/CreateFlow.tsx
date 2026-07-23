"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { parseUnits, type Address } from "viem";
import { useAccount } from "wagmi";
import { useAssets, type AllowedAsset } from "@/hooks/useAssets";
import { useLaunchRunner } from "@/hooks/useLaunchRunner";
import { useNow } from "@/hooks/useNow";
import { ConnectButton } from "@/components/app/ConnectButton";
import { isFactoryConfigured, TOTAL_SUPPLY } from "@/lib/contracts";
import { formatBackingPerToken, formatUsd } from "@/lib/format";
import { classifyFreshness, nextOpenSec, formatEt } from "@/lib/marketHours";
import { CATEGORIES, colorFor, type Category } from "@/lib/metadata";
import { activeChain } from "@/lib/chain";
import { cn } from "@/lib/cn";

const NOTICE_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

// backing per token (1e18 USD), mirroring the contract's BackingMath:
//   usd1e18       = amountRaw * price * 1e18 / (10^priceDec * 10^assetDec)
//   perToken1e18  = usd1e18 * 1e18 / TOTAL_SUPPLY
function backingPreview(amountRaw: bigint, a: AllowedAsset): { usd: bigint; perToken: bigint } | null {
  if (a.price === undefined || a.priceDecimals === undefined || a.decimals === undefined) return null;
  const usd = (amountRaw * a.price * 10n ** 18n) / (10n ** BigInt(a.priceDecimals) * 10n ** BigInt(a.decimals));
  const perToken = (usd * 10n ** 18n) / TOTAL_SUPPLY;
  return { usd, perToken };
}

export function CreateFlow() {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — project.
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [category, setCategory] = useState<Category>("Index");
  const [description, setDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");

  // Step 2 — treasury.
  const [mode, setMode] = useState<"ballast" | "none">("ballast");
  const [assetAddr, setAssetAddr] = useState<Address | "">("");
  const [amount, setAmount] = useState("");
  const [noticeDays, setNoticeDays] = useState<7 | 30 | 90>(30);

  const now = useNow();
  const { address: account } = useAccount();
  const { assets, isConfigured: registryReady, isLoading: assetsLoading, hasAssets } = useAssets();
  const runner = useLaunchRunner();

  const selected = assets.find((a) => a.address === assetAddr);
  const backed = mode === "ballast";

  const amountRaw = useMemo(() => {
    if (!selected?.decimals || !amount) return 0n;
    try {
      return parseUnits(amount, selected.decimals);
    } catch {
      return 0n;
    }
  }, [amount, selected?.decimals]);

  const preview = selected && amountRaw > 0n ? backingPreview(amountRaw, selected) : null;

  // Market-hours gate — surfaced HERE, in step 2, never as a signing revert.
  const freshness =
    selected?.updatedAt !== undefined && now > 0
      ? classifyFreshness(Number(selected.updatedAt), selected.marketHours, false, now)
      : undefined;
  const feedResting = backed && freshness ? freshness.tier !== "fresh" : false;
  const nextOpen = now > 0 ? nextOpenSec(now) : null;

  const belowMin = Boolean(selected && amountRaw > 0n && amountRaw < selected.minDeposit);

  const step1Valid = name.trim() && symbol.trim() && description.trim();
  const step2Valid = backed
    ? Boolean(selected) && amountRaw > 0n && !belowMin && !feedResting
    : true;

  const symbolClean = symbol.trim().toUpperCase().slice(0, 11);

  function submit() {
    runner.run({
      name: name.trim(),
      symbol: symbolClean,
      noticePeriod: BigInt(noticeDays) * 86400n,
      meta: { category, description: description.trim(), logoUrl: logoUrl.trim() || undefined, color: colorFor(symbolClean) },
      deposit: backed && selected ? { asset: selected.address, amount: amountRaw } : undefined,
    });
  }

  if (!isFactoryConfigured) {
    return (
      <Notice title="Not configured yet">
        The factory isn&apos;t deployed on this network. Set NEXT_PUBLIC_FACTORY_ADDRESS after deploying the core
        contracts, and the launch flow goes live.
      </Notice>
    );
  }

  // Terminal states — success / in-progress live under Review, rendered by the runner.
  const started = runner.steps.length > 0;

  return (
    <div className="space-y-5">
      <Stepper step={step} />

      {step === 1 && (
        <StepProject
          {...{ name, setName, symbol, setSymbol, symbolClean, category, setCategory, description, setDescription, logoUrl, setLogoUrl }}
          onNext={() => setStep(2)}
          valid={Boolean(step1Valid)}
        />
      )}

      {step === 2 && (
        <StepTreasury
          {...{ mode, setMode, assets, assetAddr, setAssetAddr, amount, setAmount, noticeDays, setNoticeDays }}
          registryReady={registryReady}
          assetsLoading={assetsLoading}
          hasAssets={hasAssets}
          selected={selected}
          preview={preview}
          belowMin={belowMin}
          feedResting={feedResting}
          freshness={freshness}
          nextOpen={nextOpen}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
          valid={step2Valid}
        />
      )}

      {step === 3 && (
        <StepReview
          name={name.trim()}
          symbol={symbolClean}
          category={category}
          backed={backed}
          selected={selected}
          amount={amount}
          preview={preview}
          noticeDays={noticeDays}
          account={account}
          runner={runner}
          started={started}
          onBack={() => !runner.isRunning && setStep(2)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

// ── Stepper ────────────────────────────────────────────────────────────────
function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const labels = ["Project", "Treasury", "Review"];
  return (
    <ol className="flex items-center gap-2 text-sm">
      {labels.map((l, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const active = n === step;
        const done = n < step;
        return (
          <li key={l} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                active ? "bg-green text-bg" : done ? "bg-green-bg text-green" : "bg-border text-text-muted",
              )}
            >
              {done ? "✓" : n}
            </span>
            <span className={cn(active ? "text-text-primary" : "text-text-muted")}>{l}</span>
            {i < 2 && <span className="mx-1 h-px w-6 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

// ── Step 1: Project ──────────────────────────────────────────────────────────
function StepProject(p: {
  name: string; setName: (v: string) => void;
  symbol: string; setSymbol: (v: string) => void; symbolClean: string;
  category: Category; setCategory: (v: Category) => void;
  description: string; setDescription: (v: string) => void;
  logoUrl: string; setLogoUrl: (v: string) => void;
  onNext: () => void; valid: boolean;
}) {
  return (
    <div className="space-y-4">
      <section className="card space-y-4 p-5">
        <div className="flex items-center gap-3">
          <Avatar symbol={p.symbolClean} logoUrl={p.logoUrl} />
          <div className="text-sm text-text-muted">
            Your project&apos;s mark. Uses your ticker&apos;s initials by default; paste an image URL to override.
          </div>
        </div>

        <div>
          <label className="field-label">Name</label>
          <input className="input" value={p.name} onChange={(e) => p.setName(e.target.value)} placeholder="Acme Treasury Index" maxLength={64} />
        </div>
        <div>
          <label className="field-label">Ticker</label>
          <input
            className="input uppercase"
            value={p.symbol}
            onChange={(e) => p.setSymbol(e.target.value)}
            placeholder="ACME"
            maxLength={11}
          />
          <p className="mt-1 text-xs text-text-faint">On-chain symbol: ${p.symbolClean || "TICKER"}</p>
        </div>
        <div>
          <label className="field-label">Category</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => p.setCategory(c)}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm",
                  p.category === c ? "border-green bg-green-bg text-green" : "border-border text-text-muted hover:text-text-secondary",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="field-label">Description</label>
          <textarea
            className="input min-h-[96px] resize-y"
            value={p.description}
            onChange={(e) => p.setDescription(e.target.value)}
            placeholder="What is this project, and what does its treasury hold?"
            maxLength={600}
          />
        </div>
        <div>
          <label className="field-label">Logo URL <span className="text-text-faint">(optional)</span></label>
          <input className="input" value={p.logoUrl} onChange={(e) => p.setLogoUrl(e.target.value)} placeholder="https://…" />
        </div>
        <p className="text-xs text-text-faint">
          Name and ticker are written on-chain. Category, description, and logo are listing details stored with your
          project on this device until the shared metadata service is live.
        </p>
      </section>
      <button className="btn-primary w-full" disabled={!p.valid} onClick={p.onNext}>
        Continue to treasury
      </button>
    </div>
  );
}

// ── Step 2: Treasury ─────────────────────────────────────────────────────────
function StepTreasury(p: {
  mode: "ballast" | "none"; setMode: (m: "ballast" | "none") => void;
  assets: AllowedAsset[]; assetAddr: Address | ""; setAssetAddr: (a: Address | "") => void;
  amount: string; setAmount: (v: string) => void;
  noticeDays: 7 | 30 | 90; setNoticeDays: (d: 7 | 30 | 90) => void;
  registryReady: boolean; assetsLoading: boolean; hasAssets: boolean;
  selected?: AllowedAsset;
  preview: { usd: bigint; perToken: bigint } | null;
  belowMin: boolean; feedResting: boolean;
  freshness?: { tier: string; label: string };
  nextOpen: number | null;
  onBack: () => void; onNext: () => void; valid: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* Segmented control — both options equally prominent (spec §9). */}
      <div className="grid grid-cols-2 gap-2 rounded-card border border-border p-1">
        {(["ballast", "none"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => p.setMode(m)}
            className={cn(
              "rounded-input px-3 py-2.5 text-sm font-medium",
              p.mode === m ? "bg-green-bg text-green" : "text-text-muted hover:text-text-secondary",
            )}
          >
            {m === "ballast" ? "Ballast this launch" : "No treasury"}
          </button>
        ))}
      </div>

      {p.mode === "none" ? (
        <section className="card p-5 text-sm text-text-secondary">
          <p>
            An unbacked launch. No treasury assets, no backing figure — the token opens at a fixed nominal price and
            trades on its own. You can add a treasury later by depositing, but this launch will carry no verified
            backing.
          </p>
        </section>
      ) : !p.registryReady ? (
        <Notice title="Registry not set">Deploy the AssetRegistry and set NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS.</Notice>
      ) : p.assetsLoading ? (
        <div className="card h-40 animate-pulse" />
      ) : !p.hasAssets ? (
        <Notice title="No assets allowlisted">
          The registry has no allowed assets yet. The protocol owner allowlists assets (by canonical contract address)
          before a backed launch is possible.
        </Notice>
      ) : (
        <section className="card space-y-4 p-5">
          <div>
            <label className="field-label">Treasury asset</label>
            <div className="grid gap-2">
              {p.assets.map((a) => (
                <button
                  key={a.address}
                  type="button"
                  onClick={() => p.setAssetAddr(a.address)}
                  className={cn(
                    "flex items-center justify-between rounded-input border px-3 py-2.5 text-left text-sm",
                    p.assetAddr === a.address ? "border-green bg-green-bg" : "border-border hover:border-text-faint",
                  )}
                >
                  <span className="font-medium text-text-primary">{a.symbol ?? "asset"}</span>
                  <span className="metric-secondary">
                    {a.marketHours === 1 ? "US equities · 24/5" : a.marketHours === 2 ? "Crypto · 24/7" : "—"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="field-label">Amount to deposit</label>
            <input
              className="input"
              inputMode="decimal"
              value={p.amount}
              onChange={(e) => p.setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.0"
              disabled={!p.selected}
            />
            {p.belowMin && p.selected && (
              <p className="mt-1 text-xs text-warning">Below the minimum deposit for this asset.</p>
            )}
          </div>

          {/* LIVE backing-per-token preview. Never counts up — it just reflects the input. */}
          <div className="rounded-input bg-bg p-4">
            <div className="text-xs uppercase tracking-wide text-text-faint">Resulting backing per token</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="figure-primary text-2xl">
                {p.preview ? formatBackingPerToken(p.preview.perToken) : "$0.00"}
              </span>
              <span className="metric-secondary">
                {p.preview ? `${formatUsd(p.preview.usd, { compact: true })} across 1B tokens` : "enter an amount"}
              </span>
            </div>
            <p className="mt-2 text-xs text-text-muted">
              The pool opens at this backing. Flooring to the pool&apos;s tick spacing can seat it up to ~0.7% below;
              it never opens above backing.
            </p>
          </div>

          <div>
            <label className="field-label">Withdrawal notice period</label>
            <div className="grid grid-cols-3 gap-2">
              {NOTICE_OPTIONS.map((o) => (
                <button
                  key={o.days}
                  type="button"
                  onClick={() => p.setNoticeDays(o.days)}
                  className={cn(
                    "rounded-input border py-2 text-sm",
                    p.noticeDays === o.days ? "border-green bg-green-bg text-green" : "border-border text-text-muted",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-text-muted">
              You may withdraw only what you deposit, and every withdrawal is announced publicly and delayed by this
              period. This choice is permanent — the treasury cannot change it later.
            </p>
          </div>

          {/* MARKET-HOURS GATE — before Review, never a post-signing revert. */}
          {p.feedResting && (
            <div className="rounded-card border border-warning-border bg-warning-bg p-4 text-sm">
              <div className="flex items-center gap-2 font-semibold text-warning">
                <span aria-hidden>⚠</span> Market closed — backed launch can&apos;t price yet
              </div>
              <p className="mt-2 text-text-secondary">
                {p.selected?.symbol}&apos;s feed is {p.freshness?.label.toLowerCase()}. A backed launch opens the pool at
                your treasury&apos;s live value, so its feed must be trading (fresh), not resting. Launch during market
                hours.{" "}
                {p.nextOpen ? (
                  <>Next window opens <span className="font-semibold text-text-primary">{formatEt(p.nextOpen)}</span>.</>
                ) : (
                  <>The next open time is beyond our market calendar — check back closer to a weekday session.</>
                )}
              </p>
            </div>
          )}
        </section>
      )}

      <div className="grid grid-cols-2 gap-3">
        <button className="btn-secondary" onClick={p.onBack}>Back</button>
        <button className="btn-primary" disabled={!p.valid} onClick={p.onNext}>Review launch</button>
      </div>
    </div>
  );
}

// ── Step 3: Review ─────────────────────────────────────────────────────────
function StepReview(p: {
  name: string; symbol: string; category: string; backed: boolean;
  selected?: AllowedAsset; amount: string;
  preview: { usd: bigint; perToken: bigint } | null;
  noticeDays: number; account?: Address;
  runner: ReturnType<typeof useLaunchRunner>;
  started: boolean;
  onBack: () => void; onSubmit: () => void;
}) {
  const { runner } = p;

  if (runner.result) {
    return (
      <div className="space-y-4">
        <section className="card p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-bg text-2xl text-green">✓</div>
          <h2 className="mt-3 text-lg font-semibold text-text-primary">${p.symbol} is live</h2>
          <p className="mt-1 text-sm text-text-muted">Its pool is seeded and the LP is locked permanently.</p>
          <div className="mt-4 grid gap-2">
            <Link href={`/app/token/${runner.result.token}`} className="btn-primary">View {p.symbol}</Link>
            <a
              className="btn-secondary"
              href={`${activeChain.blockExplorers.default.url}/token/${runner.result.token}`}
              target="_blank"
              rel="noreferrer"
            >
              View token on Blockscout ↗
            </a>
          </div>
        </section>
      </div>
    );
  }

  if (p.started) {
    return (
      <div className="space-y-4">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-text-primary">Launching ${p.symbol}</h2>
          <ol className="mt-4 space-y-3">
            {runner.steps.map((s) => (
              <li key={s.key} className="flex items-start gap-3">
                <StepDot status={s.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text-primary">{s.label}</div>
                  {s.txHash && (
                    <a
                      className="text-xs text-text-faint hover:text-text-secondary"
                      href={`${activeChain.blockExplorers.default.url}/tx/${s.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.status === "confirming" ? "Confirming" : "View"} on Blockscout ↗
                    </a>
                  )}
                  {s.error && <div className="text-xs text-negative">{s.error}</div>}
                </div>
              </li>
            ))}
          </ol>
          {runner.steps.some((s) => s.status === "error") && !runner.isRunning && (
            <button className="btn-primary mt-4 w-full" onClick={p.onSubmit}>Retry</button>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="card divide-y divide-border">
        <Row label="Project" value={`${p.name} · $${p.symbol}`} />
        <Row label="Category" value={p.category} />
        <Row
          label="Treasury"
          value={
            p.backed && p.selected
              ? `${p.amount} ${p.selected.symbol ?? "asset"} · ${p.preview ? formatBackingPerToken(p.preview.perToken) : "$0.00"}/token`
              : "None — unbacked launch"
          }
        />
        {p.backed && <Row label="Withdrawal notice" value={`${p.noticeDays} days (permanent)`} />}
      </section>

      {/* Locked-on facts. */}
      <section className="card space-y-2 p-4 text-sm text-text-secondary">
        <Fact>100% of supply seeds the pool — you receive no token allocation, no presale, no team bag.</Fact>
        <Fact>The LP is locked permanently. Neither you nor anyone can pull the pool.</Fact>
        {p.backed && <Fact>You may withdraw only what you deposit, publicly announced and delayed {p.noticeDays} days. Third-party deposits are locked forever.</Fact>}
      </section>

      {/* Amber disclosure notice — verbatim intent from spec §9. */}
      <section className="rounded-card border border-warning-border bg-warning-bg p-4 text-sm text-warning">
        Backing is disclosure only. You are not promising holders any claim, redemption, or return.
      </section>

      {!p.account ? (
        <div className="card p-4 text-center text-sm text-text-muted">
          <p className="mb-3">Connect a wallet to launch.</p>
          <div className="flex justify-center"><ConnectButton /></div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <button className="btn-secondary" onClick={p.onBack}>Back</button>
          <button className="btn-primary" onClick={p.onSubmit}>Launch ${p.symbol}</button>
        </div>
      )}
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────
function Avatar({ symbol, logoUrl }: { symbol: string; logoUrl?: string }) {
  const bg = colorFor(symbol || "•");
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />;
  }
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: bg }}>
      {(symbol || "•").slice(0, 3)}
    </div>
  );
}

function StepDot({ status }: { status: string }) {
  if (status === "success") return <span className="mt-0.5 text-green">✓</span>;
  if (status === "error") return <span className="mt-0.5 text-negative">✕</span>;
  if (status === "pending" || status === "confirming")
    return <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-green" />;
  return <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-border" />;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="text-right font-medium text-text-primary">{value}</span>
    </div>
  );
}

function Fact({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="mt-1 text-green" aria-hidden>•</span>
      <span>{children}</span>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-6 text-center">
      <h2 className="font-semibold text-text-primary">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{children}</p>
    </div>
  );
}
