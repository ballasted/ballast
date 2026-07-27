"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { parseUnits, formatUnits, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useAssets, type AllowedAsset } from "@/hooks/useAssets";
import { useLaunchRunner, type LaunchParams } from "@/hooks/useLaunchRunner";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useFeeSplit } from "@/hooks/useFeeSplit";
import { useNow } from "@/hooks/useNow";
import { ConnectButton } from "@/components/app/ConnectButton";
import { WalletBalance } from "@/components/app/WalletBalance";
import { ActingAs } from "@/components/app/ActingAs";
import { Logo } from "@/components/app/Logo";
import { erc20Abi } from "@/lib/abis";
import { isFactoryConfigured, FACTORY_ADDRESS, TOTAL_SUPPLY } from "@/lib/contracts";
import { formatBackingPerToken, formatUsd, shortAddress } from "@/lib/format";
import { classifyFreshness, nextOpenSec, formatEt } from "@/lib/marketHours";
import { CATEGORIES, type Category } from "@/lib/metadata";
import { activeChain } from "@/lib/chain";
import { cn } from "@/lib/cn";
import {
  pinFile,
  pinJson,
  resizeImage,
  isAcceptedImage,
  ipfsToGateway,
  MAX_UPLOAD_BYTES,
} from "@/lib/ipfs";

const CHAIN_ID = activeChain.id;

const NOTICE_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const NAME_MAX = 32;
const SYMBOL_MAX = 10;
const DESC_MAX = 256;

// backing per token (1e18 USD), mirroring the contract's BackingMath:
//   usd1e18       = amountRaw * price * 1e18 / (10^priceDec * 10^assetDec)
//   perToken1e18  = usd1e18 * 1e18 / TOTAL_SUPPLY
function backingPreview(amountRaw: bigint, a: AllowedAsset): { usd: bigint; perToken: bigint } | null {
  if (a.price === undefined || a.priceDecimals === undefined || a.decimals === undefined) return null;
  const usd = (amountRaw * a.price * 10n ** 18n) / (10n ** BigInt(a.priceDecimals) * 10n ** BigInt(a.decimals));
  const perToken = (usd * 10n ** 18n) / TOTAL_SUPPLY;
  return { usd, perToken };
}

// Strip any leading @ or platform prefix so we store a bare handle.
function cleanHandle(v: string): string {
  return v
    .trim()
    .replace(/^@/, "")
    .replace(/^(https?:\/\/)?(www\.)?(x\.com\/|twitter\.com\/|t\.me\/)?/i, "")
    .replace(/\/+$/, "");
}

// The single-page create flow (spec Phase 2). The three-step wizard is gone: the
// live backing-per-token figure must move as the user types a treasury amount, and
// that only works with the form and its preview on one screen at once.
export function CreateFlow() {
  // Project
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [category, setCategory] = useState<Category>("Index");
  const [description, setDescription] = useState("");
  const [logoUri, setLogoUri] = useState(""); // ipfs://CID (uploaded) or manual URL
  const [xHandle, setXHandle] = useState("");
  const [tgHandle, setTgHandle] = useState("");

  // Treasury
  const [mode, setMode] = useState<"ballast" | "none">("ballast");
  const [assetAddr, setAssetAddr] = useState<Address | "">("");
  const [amount, setAmount] = useState("");
  const [noticeDays, setNoticeDays] = useState<7 | 30 | 90>(30);
  const [advanced, setAdvanced] = useState(false);

  // Submit lifecycle
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>();
  const [launchParams, setLaunchParams] = useState<LaunchParams | null>(null);

  const now = useNow();
  const { address: account } = useAccount();
  const { wrongNetwork, switchToRobinhood, isSwitching } = useNetworkGuard();
  const { assets, isConfigured: registryReady, isLoading: assetsLoading, isError: assetsError, hasAssets } = useAssets();
  const { split: feeSplit, isLoading: feeLoading, configured: feeConfigured } = useFeeSplit();
  const runner = useLaunchRunner();

  const selected = assets.find((a) => a.address === assetAddr);
  const backed = mode === "ballast";
  const symbolClean = symbol.trim().toUpperCase().slice(0, SYMBOL_MAX);

  // Creator's balance of the selected asset — powers the Max button.
  const balRes = useReadContract({
    address: selected?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(selected && account) },
  });
  const balance = balRes.data as bigint | undefined;

  const amountRaw = useMemo(() => {
    if (!selected?.decimals || !amount) return 0n;
    try {
      return parseUnits(amount, selected.decimals);
    } catch {
      return 0n;
    }
  }, [amount, selected?.decimals]);

  const preview = selected && amountRaw > 0n ? backingPreview(amountRaw, selected) : null;

  // Market-hours classification — same classifier the display path uses, so the
  // gate and the UI can never disagree (spec 2.3).
  const freshness =
    selected?.updatedAt !== undefined && now > 0
      ? classifyFreshness(Number(selected.updatedAt), selected.marketHours, false, now)
      : undefined;
  const feedResting = backed && freshness ? freshness.tier !== "fresh" : false;
  const nextOpen = now > 0 ? nextOpenSec(now) : null;

  const belowMin = Boolean(selected && amountRaw > 0n && amountRaw < selected.minDeposit);
  const overBalance = Boolean(balance !== undefined && amountRaw > balance);
  const hasLink = /(https?:\/\/|www\.)/i.test(description);

  const projectValid = Boolean(name.trim()) && Boolean(symbolClean) && Boolean(description.trim()) && !hasLink;
  const treasuryValid = backed
    ? Boolean(selected) && amountRaw > 0n && !belowMin && !overBalance && !feedResting
    : true;
  const formValid = projectValid && treasuryValid;

  function openConfirm() {
    setPinError(undefined);
    setConfirmOpen(true);
  }

  async function confirmAndLaunch() {
    setConfirmOpen(false);
    setPinError(undefined);
    setPinning(true);
    try {
      const metadataURI = await pinJson({
        name: name.trim(),
        symbol: symbolClean,
        description: description.trim(),
        category,
        logo: logoUri.trim() || undefined,
        x: xHandle.trim() ? `x.com/${cleanHandle(xHandle)}` : undefined,
        telegram: tgHandle.trim() ? `t.me/${cleanHandle(tgHandle)}` : undefined,
      });
      setPinning(false);
      const params: LaunchParams = {
        name: name.trim(),
        symbol: symbolClean,
        noticePeriod: BigInt(noticeDays) * 86400n,
        metadataURI,
        deposit: backed && selected ? { asset: selected.address, amount: amountRaw } : undefined,
      };
      // Remember the pinned params so a resume/retry re-runs WITHOUT re-pinning
      // (a new CID for the same metadata) — and the runner skips any step already
      // on-chain, so it never re-deploys or re-deposits.
      setLaunchParams(params);
      runner.run(params);
    } catch (e) {
      setPinning(false);
      setPinError(e instanceof Error ? e.message : "Could not pin project metadata to IPFS.");
    }
  }

  // Re-run from where we left off, reusing the already-pinned metadata. Safe to
  // call after an error or a lost step: the runner prechecks each step on-chain.
  function resumeLaunch() {
    if (launchParams) runner.run(launchParams);
  }

  if (!isFactoryConfigured) {
    return (
      <Notice title="Not configured yet">
        The factory isn&apos;t deployed on this network. Set NEXT_PUBLIC_FACTORY_ADDRESS after deploying the core
        contracts, and the launch flow goes live.
      </Notice>
    );
  }

  // Terminal + in-progress states take over the whole view.
  if (runner.result) {
    return <SuccessCard token={runner.result.token} symbol={symbolClean} logoUri={logoUri} />;
  }
  const running = pinning || runner.steps.length > 0;
  if (running) {
    return (
      <LaunchProgress
        symbol={symbolClean}
        pinning={pinning}
        steps={runner.steps}
        isRunning={runner.isRunning}
        launched={runner.launched}
        onResume={resumeLaunch}
      />
    );
  }

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── LEFT: form ──────────────────────────────────────────────── */}
        <div className="space-y-5">
          <section className="card space-y-4 p-5">
            <LogoUploader symbol={symbolClean} logoUri={logoUri} setLogoUri={setLogoUri} />

            <Field label="Name" hint={`${name.length}/${NAME_MAX}`}>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                placeholder="Acme Treasury Index"
                maxLength={NAME_MAX}
              />
            </Field>

            <Field label="Ticker" hint={`$${symbolClean || "TICKER"}`}>
              <input
                className="input uppercase"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.slice(0, SYMBOL_MAX))}
                placeholder="ACME"
                maxLength={SYMBOL_MAX}
              />
            </Field>

            <Field label="Category">
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-sm transition-colors",
                      category === c
                        ? "border-green bg-green-bg text-green"
                        : "border-border text-text-muted hover:text-text-secondary",
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Description" hint={`${description.length}/${DESC_MAX}`}>
              <textarea
                className="input min-h-[96px] resize-y"
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))}
                placeholder="What is this project, and what does its treasury hold?"
                maxLength={DESC_MAX}
              />
              {hasLink && (
                <p className="mt-1 text-xs text-negative">
                  Links aren&apos;t allowed in the description. Put them in the X / Telegram fields below.
                </p>
              )}
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="X" optional>
                <PrefixInput prefix="x.com/" value={xHandle} onChange={setXHandle} placeholder="handle" />
              </Field>
              <Field label="Telegram" optional>
                <PrefixInput prefix="t.me/" value={tgHandle} onChange={setTgHandle} placeholder="handle" />
              </Field>
            </div>
          </section>

          {/* Treasury */}
          <section className="card space-y-4 p-5">
            <div className="grid grid-cols-2 gap-2 rounded-card border border-border p-1">
              {(["ballast", "none"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    "rounded-input px-3 py-2.5 text-sm font-medium transition-colors",
                    mode === m ? "bg-green-bg text-green" : "text-text-muted hover:text-text-secondary",
                  )}
                >
                  {m === "ballast" ? "Ballast this launch" : "No treasury"}
                </button>
              ))}
            </div>

            {mode === "none" ? (
              <p className="text-sm text-text-secondary">
                An unbacked launch. No treasury assets, no backing figure — the token opens at a fixed nominal price and
                trades on its own. You can add a treasury later by depositing, but this launch carries no verified
                backing.
              </p>
            ) : !registryReady ? (
              <InlineNotice>Deploy the AssetRegistry and set NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS.</InlineNotice>
            ) : assetsLoading ? (
              <Field label="Treasury asset">
                <AssetPickerSkeleton />
              </Field>
            ) : assetsError ? (
              <InlineNotice tone="warning">
                Couldn&apos;t read the asset registry from the chain right now — the RPC may be rate-limited or down.
                This isn&apos;t &ldquo;no assets&rdquo;; it&apos;s a failed read. Retry in a moment.
              </InlineNotice>
            ) : !hasAssets ? (
              <InlineNotice>
                The registry has no allowed assets yet. The protocol owner allowlists assets (by canonical contract
                address) before a backed launch is possible.
              </InlineNotice>
            ) : (
              <>
                <Field label="Treasury asset">
                  <div className="grid gap-2">
                    {assets.map((a) => (
                      <AssetPickerOption
                        key={a.address}
                        a={a}
                        now={now}
                        selected={assetAddr === a.address}
                        onSelect={() => setAssetAddr(a.address)}
                      />
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-text-faint">
                    Price and freshness are read live from each asset&apos;s Chainlink feed. A backed launch can only
                    price against a feed that&apos;s trading — an asset showing anything but a live feed is why a launch
                    is gated outside market hours.
                  </p>
                </Field>

                <Field label="Amount to deposit">
                  <div className="relative">
                    <input
                      className="input pr-16"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0.0"
                      disabled={!selected}
                    />
                    {selected && balance !== undefined && (
                      <button
                        type="button"
                        onClick={() => setAmount(formatUnits(balance, selected.decimals ?? 18))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-border px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
                      >
                        Max
                      </button>
                    )}
                  </div>
                  {selected && balance !== undefined && (
                    <p className="mt-1 text-xs text-text-faint">
                      Balance: {Number(formatUnits(balance, selected.decimals ?? 18)).toLocaleString("en", { maximumFractionDigits: 6 })}{" "}
                      {selected.symbol}
                    </p>
                  )}
                  {belowMin && selected && <p className="mt-1 text-xs text-warning">Below the minimum deposit for this asset.</p>}
                  {overBalance && <p className="mt-1 text-xs text-negative">More than your wallet holds.</p>}
                </Field>

                <Field label="Withdrawal notice period">
                  <div className="grid grid-cols-3 gap-2">
                    {NOTICE_OPTIONS.map((o) => (
                      <button
                        key={o.days}
                        type="button"
                        onClick={() => setNoticeDays(o.days)}
                        className={cn(
                          "rounded-input border py-2 text-sm transition-colors",
                          noticeDays === o.days ? "border-green bg-green-bg text-green" : "border-border text-text-muted",
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-text-muted">
                    You may withdraw only what you deposit, every withdrawal is announced publicly and delayed by this
                    period, and this choice is permanent — the treasury cannot change it later.
                  </p>
                </Field>

                {/* Market-hours gate — surfaced HERE, before signing (spec 2.3). */}
                {feedResting && (
                  <div className="rounded-card border border-warning-border bg-warning-bg p-4 text-sm">
                    <div className="flex items-center gap-2 font-semibold text-warning">
                      <span aria-hidden>⚠</span> Market closed — a backed launch can&apos;t price yet
                    </div>
                    <p className="mt-2 text-text-secondary">
                      {selected?.symbol}&apos;s feed is {freshness?.label.toLowerCase()}. A backed launch opens the pool at
                      your treasury&apos;s live value, so its feed must be trading, not resting.{" "}
                      {nextOpen ? (
                        <>Next window opens <span className="font-semibold text-text-primary">{formatEt(nextOpen)}</span>.</>
                      ) : (
                        <>The next open time is beyond our market calendar — check back closer to a weekday session.</>
                      )}
                    </p>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Advanced — creator wallet. See note: the factory records msg.sender as
              creator; there is no override parameter, so we surface the address as a
              read-only fact rather than a non-functional input. */}
          <section className="card p-5">
            <button
              type="button"
              onClick={() => setAdvanced((a) => !a)}
              className="flex w-full items-center justify-between text-sm font-medium text-text-secondary"
            >
              Advanced
              <span className="text-text-faint">{advanced ? "–" : "+"}</span>
            </button>
            {advanced && (
              <div className="mt-3 space-y-2 text-sm text-text-muted">
                <div className="flex items-center justify-between">
                  <span>Creator address</span>
                  <span className="font-mono text-text-primary">{account ? shortAddress(account) : "connect a wallet"}</span>
                </div>
                <p className="text-xs text-text-faint">
                  The wallet you launch from is recorded on-chain as the creator and receives the creator share of swap
                  fees. It cannot be changed after launch.
                </p>
              </div>
            )}
          </section>

          {/* Primary action */}
          {!account ? (
            <div className="card p-4 text-center text-sm text-text-muted">
              <p className="mb-3">Connect a wallet to launch.</p>
              <div className="flex justify-center"><ConnectButton /></div>
            </div>
          ) : wrongNetwork ? (
            <button className="btn-primary w-full" onClick={() => void switchToRobinhood()} disabled={isSwitching}>
              {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
            </button>
          ) : (
            <>
              {/* Which wallet is launching, and its funds — both read through our
                  own transport (not reown's modal) so the acting address and a zero
                  balance are both visible up front. */}
              <ActingAs className="mb-2 w-full" label="Launching from" />
              <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
                <span>Wallet balance</span>
                <WalletBalance />
              </div>
              <button className="btn-primary w-full" disabled={!formValid} onClick={openConfirm}>
                Review &amp; launch ${symbolClean || "TICKER"}
              </button>
            </>
          )}
          {pinError && <p className="text-center text-xs text-negative">{pinError}</p>}
        </div>

        {/* ── RIGHT: live preview ─────────────────────────────────────── */}
        <div>
          <div className="lg:sticky lg:top-20">
            <PreviewCard
              name={name.trim()}
              symbol={symbolClean}
              category={category}
              logoUri={logoUri}
              backed={backed}
              selected={selected}
              amount={amount}
              preview={preview}
              feeSplit={feeSplit}
              feeLoading={feeLoading}
              feeConfigured={feeConfigured}
              freshness={freshness}
            />
          </div>
        </div>
      </div>

      {confirmOpen && (
        <ConfirmModal
          name={name.trim()}
          symbol={symbolClean}
          backed={backed}
          selected={selected}
          amount={amount}
          preview={preview}
          noticeDays={noticeDays}
          feeSplit={feeSplit}
          feeLoading={feeLoading}
          feeConfigured={feeConfigured}
          account={account}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={confirmAndLaunch}
        />
      )}
    </>
  );
}

// ── Live preview card ─────────────────────────────────────────────────────────
function PreviewCard(p: {
  name: string; symbol: string; category: string; logoUri: string;
  backed: boolean; selected?: AllowedAsset; amount: string;
  preview: { usd: bigint; perToken: bigint } | null;
  feeSplit?: { creatorPct: number; platformPct: number; referrerPct: number; feePct: number };
  feeLoading?: boolean;
  feeConfigured?: boolean;
  freshness?: { tier: string; label: string };
}) {
  return (
    <section className="card-raised overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <Logo src={ipfsToGateway(p.logoUri)} symbol={p.symbol} size={44} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-text-primary">{p.name || "Your project"}</div>
          <div className="metric-secondary">${p.symbol || "TICKER"} · {p.category}</div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {/* Backing per token — the reason the preview lives on the same screen.
            Reflects the input; it never counts up (Phase 4 motion rule 2). */}
        <div className="rounded-input border border-accent bg-bg p-4">
          <div className="text-xs uppercase tracking-wide text-text-faint">Backing per token</div>
          <div className="mt-1 figure-primary text-3xl">
            {/* Keyed by the formatted value so a change crossfades the new figure
                in (Phase 3) — it appears settled, never counts up toward a value
                (hard rule 2). Reduced-motion makes this an instant swap. */}
            {(() => {
              const v = p.backed ? (p.preview ? formatBackingPerToken(p.preview.perToken) : "$0.00") : "None";
              return (
                <span key={v} className="anim-fade inline-block">
                  {v}
                </span>
              );
            })()}
          </div>
          {p.backed && (
            <div className="metric-secondary mt-0.5">
              {p.preview ? `${formatUsd(p.preview.usd, { compact: true })} treasury across 1B tokens` : "enter a treasury amount"}
            </div>
          )}
        </div>

        {/* Treasury composition */}
        {p.backed && (
          <PreviewRow label="Treasury">
            {p.selected && p.amount ? (
              <span>
                {p.amount} {p.selected.symbol}
                {p.preview ? <span className="text-text-muted"> · {formatUsd(p.preview.usd, { compact: true })}</span> : null}
              </span>
            ) : (
              <span className="text-right text-text-faint">
                {p.selected ? "Enter an amount to deposit" : "Choose an asset below"}
              </span>
            )}
          </PreviewRow>
        )}

        {p.backed && p.selected && (
          <PreviewRow label="Market hours">
            {p.freshness ? (
              <span className={p.freshness.tier === "fresh" ? "text-green" : "text-warning"}>{p.freshness.label}</span>
            ) : (
              <span className="text-text-faint">checking feed…</span>
            )}
          </PreviewRow>
        )}

        <PreviewRow label="Fee split">
          <FeeSplitValue split={p.feeSplit} loading={p.feeLoading} configured={p.feeConfigured} />
        </PreviewRow>

        <PreviewRow label="Liquidity">Locked permanently</PreviewRow>
        <PreviewRow label="Creator allocation">
          <span className="text-green">None</span>
        </PreviewRow>

        <p className="border-t border-border pt-3 text-xs text-text-faint">
          100% of supply seeds the pool. You receive no allocation, no presale, no team bag — the one thing that makes a
          BALLAST launch structurally different.
        </p>
      </div>
    </section>
  );
}

// ── Confirm modal (spec 2.4) — deliberately blunt, no motion (Phase 4 rule 4). ──
function ConfirmModal(p: {
  name: string; symbol: string; backed: boolean; selected?: AllowedAsset; amount: string;
  preview: { usd: bigint; perToken: bigint } | null; noticeDays: number;
  feeSplit?: { creatorPct: number; platformPct: number; referrerPct: number };
  feeLoading?: boolean; feeConfigured?: boolean;
  account?: Address; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="card w-full max-w-md p-5">
        <h2 className="text-lg font-semibold text-text-primary">Confirm launch</h2>
        <p className="mt-1 text-sm text-text-muted">Everything below is written on-chain. Review before you sign.</p>

        <dl className="mt-4 divide-y divide-border">
          <ConfirmRow label="Token" value={`${p.name} · $${p.symbol}`} />
          <ConfirmRow
            label="Treasury"
            value={p.backed && p.selected ? `${p.amount} ${p.selected.symbol ?? "asset"}` : "None — unbacked"}
          />
          <ConfirmRow
            label="Backing per token"
            value={p.backed ? (p.preview ? formatBackingPerToken(p.preview.perToken) : "$0.00") : "n/a — unbacked"}
          />
          <ConfirmRow label="Withdrawal notice" value={p.backed ? `${p.noticeDays} days (permanent)` : "n/a — unbacked"} />
          <ConfirmRow label="Fee split" value={feeSplitText(p.feeSplit, p.feeLoading, p.feeConfigured)} />
          <ConfirmRow label="Creator" value={p.account ? shortAddress(p.account) : "—"} mono />
          <ConfirmRow label="Network" value={activeChain.name} />
          <ConfirmRow label="Factory" value={FACTORY_ADDRESS ? shortAddress(FACTORY_ADDRESS) : "—"} mono />
        </dl>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button className="btn-secondary" onClick={p.onCancel}>Cancel</button>
          <button className="btn-primary" onClick={p.onConfirm}>Confirm &amp; launch</button>
        </div>
      </div>
    </div>
  );
}

// ── Transaction progress (spec 2.5) ────────────────────────────────────────────
function LaunchProgress(p: {
  symbol: string; pinning: boolean;
  steps: ReturnType<typeof useLaunchRunner>["steps"];
  isRunning: boolean;
  launched: { token: Address; treasury: Address } | null;
  onResume: () => void;
}) {
  const errorStep = p.steps.find((s) => s.status === "error");
  const lostStep = p.steps.find((s) => s.status === "lost");
  // A lost LAUNCH tx is the one case we must NOT auto-retry: we never decoded the
  // token, so retrying would deploy a duplicate. Every later lost step is safe to
  // resume because the runner prechecks on-chain and skips completed work.
  const lostAtLaunch = lostStep?.key === "launch";
  const canResume = !p.isRunning && (Boolean(errorStep) || (Boolean(lostStep) && !lostAtLaunch));

  return (
    <div className="mx-auto max-w-md">
      <section className="card p-5">
        <h2 className="text-sm font-semibold text-text-primary">Launching ${p.symbol}</h2>
        {p.pinning && <p className="mt-2 text-sm text-text-muted">Pinning project metadata to IPFS…</p>}
        <ol className="mt-4 space-y-3">
          {p.steps.map((s) => (
            <li key={s.key} className="flex items-start gap-3">
              <StepDot status={s.status} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-text-primary">{s.label}</div>
                {s.txHash && (
                  <a
                    className="break-all text-xs text-text-faint hover:text-text-secondary"
                    href={`${activeChain.blockExplorers.default.url}/tx/${s.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.status === "confirming"
                      ? "Waiting for confirmation · view on Blockscout ↗"
                      : "View on Blockscout ↗"}
                  </a>
                )}
                {s.error && <div className="text-xs text-negative">{s.error}</div>}
              </div>
            </li>
          ))}
        </ol>

        {/* Lost = timed out, outcome unknown. Never a red X + blind Retry — the tx
            may have succeeded and retrying could double-deploy. Show the hash and
            send them to the explorer first. */}
        {lostStep && !p.isRunning && (
          <div className="mt-4 rounded-input border border-warning-border bg-warning-bg p-3 text-sm">
            <div className="font-semibold text-warning">We lost track of this transaction</div>
            <p className="mt-1 text-text-secondary">
              It may still have succeeded — check Blockscout before retrying, so you don&apos;t send it twice.
            </p>
            {lostStep.txHash && (
              <a
                className="mt-2 block break-all font-mono text-xs text-text-primary underline underline-offset-2"
                href={`${activeChain.blockExplorers.default.url}/tx/${lostStep.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {lostStep.txHash} ↗
              </a>
            )}
            {p.launched && (
              <Link
                href={`/app/token/${p.launched.token}`}
                className="mt-2 inline-block text-xs text-green underline underline-offset-2"
              >
                Open the token page — resume from there if the pool isn&apos;t seeded ↗
              </Link>
            )}
          </div>
        )}

        {canResume && (
          <button className="btn-primary mt-4 w-full" onClick={p.onResume}>
            {lostStep ? "I checked Blockscout — resume" : "Resume"}
          </button>
        )}
      </section>
    </div>
  );
}

function SuccessCard({ token, symbol, logoUri }: { token: Address; symbol: string; logoUri: string }) {
  return (
    <div className="mx-auto max-w-md">
      <section className="card p-6 text-center">
        <div className="mx-auto w-fit"><Logo src={ipfsToGateway(logoUri)} symbol={symbol} size={48} /></div>
        <h2 className="mt-3 text-lg font-semibold text-text-primary">${symbol} is live</h2>
        <p className="mt-1 text-sm text-text-muted">Its pool is seeded and the LP is locked permanently.</p>
        <div className="mt-4 grid gap-2">
          <Link href={`/app/token/${token}`} className="btn-primary">View ${symbol}</Link>
          <a
            className="btn-secondary"
            href={`${activeChain.blockExplorers.default.url}/token/${token}`}
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

// ── Logo uploader with the artwork-moderation gate (spec 2.1) ───────────────────
function LogoUploader({
  symbol,
  logoUri,
  setLogoUri,
}: {
  symbol: string;
  logoUri: string;
  setLogoUri: (v: string) => void;
}) {
  const [ack, setAck] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [manual, setManual] = useState(false);

  async function onFile(file: File) {
    setError(undefined);
    if (!isAcceptedImage(file)) {
      setError("Use a PNG, JPG, SVG, or WebP image.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Image is over 1 MB. Pick a smaller file.");
      return;
    }
    setUploading(true);
    try {
      const resized = await resizeImage(file, 512);
      const uri = await pinFile(resized, "logo.png");
      setLogoUri(uri);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const preview = ipfsToGateway(logoUri);
  const locked = !ack;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Logo src={preview} symbol={symbol} size={56} />
        <div className="min-w-0 flex-1">
          <label
            className={cn(
              "btn-secondary inline-flex items-center gap-2 px-3 py-2 text-sm",
              locked ? "cursor-not-allowed opacity-40" : "cursor-pointer",
            )}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
              disabled={uploading || locked}
            />
            {uploading ? "Uploading…" : logoUri ? "Replace logo" : "Upload logo"}
          </label>
          <p className="mt-1 text-xs text-text-faint">PNG/JPG/SVG/WebP, up to 1 MB. Resized to 512×512 and pinned to IPFS.</p>
        </div>
      </div>

      {/* The moderation acknowledgement gates the picker — it sets the expectation
          that the upload is permanent and public before a file can be chosen. */}
      <label className="flex cursor-pointer items-start gap-2 text-xs text-text-secondary">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-green" />
        I understand that selected artwork will be moderated and uploaded to public IPFS.
      </label>

      {error && <p className="text-xs text-negative">{error}</p>}

      {!locked && (
        <>
          <button
            type="button"
            onClick={() => setManual((m) => !m)}
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            {manual ? "Hide" : "Already hosting your image? Paste a URL instead"}
          </button>
          {manual && (
            <input
              className="input"
              value={logoUri.startsWith("ipfs://") ? "" : logoUri}
              onChange={(e) => setLogoUri(e.target.value)}
              placeholder="https://… or ipfs://…"
            />
          )}
        </>
      )}
    </div>
  );
}

// One row in the treasury-asset picker. Shows the live feed price and the SAME
// freshness classification the launch gate uses, so a creator can see at a glance
// why a backed launch might be blocked (a resting/stale feed) before they commit.
function AssetPickerOption({
  a,
  selected,
  onSelect,
  now,
}: {
  a: AllowedAsset;
  selected: boolean;
  onSelect: () => void;
  now: number;
}) {
  const freshness =
    a.updatedAt !== undefined && now > 0
      ? classifyFreshness(Number(a.updatedAt), a.marketHours, false, now)
      : undefined;
  const tone =
    freshness?.tier === "fresh"
      ? "text-green"
      : freshness?.tier === "stale"
        ? "text-negative"
        : "text-warning";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between gap-3 rounded-input border px-3 py-2.5 text-left transition-colors",
        selected ? "border-green bg-green-bg" : "border-border hover:border-text-faint",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text-primary">{a.symbol ?? "asset"}</span>
        <span className="metric-secondary">
          {a.marketHours === 1 ? "US equities · 24/5" : a.marketHours === 2 ? "Crypto · 24/7" : "—"}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-medium text-text-primary">{formatFeedPrice(a.price, a.priceDecimals)}</span>
        {freshness && (
          <span className={cn("metric-secondary inline-flex items-center gap-1", tone)}>
            <span aria-hidden>•</span> {freshness.label}
          </span>
        )}
      </span>
    </button>
  );
}

// Raw Chainlink answer (price + its own decimals) → a dollar string. Feed decimals
// are read live per asset, never assumed 8 (CLAUDE.md rule 9 / research §3).
function formatFeedPrice(price?: bigint, dec?: number): string {
  if (price === undefined || dec === undefined) return "—";
  const v = Number(price) / 10 ** dec;
  return `$${Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
}

// The live fee split, read from the deployed FeeConfig — never the string "read
// live from FeeConfig" in place of the value (Phase 1). Three honest states:
// resolved → the numbers; loading → a skeleton; configured-but-failed / unset →
// a plain reason, so a failed read never masquerades as a value.
function FeeSplitValue({
  split,
  loading,
  configured,
}: {
  split?: { creatorPct: number; platformPct: number; referrerPct: number };
  loading?: boolean;
  configured?: boolean;
}) {
  if (split) {
    return (
      <span>
        {split.creatorPct}% creator · {split.platformPct}% platform · {split.referrerPct}% referrer
      </span>
    );
  }
  if (loading) return <span className="inline-block h-4 w-40 animate-pulse rounded bg-surface-raised align-middle" />;
  return (
    <span className="text-text-faint">
      {configured ? "couldn’t read FeeConfig — retry" : "FeeConfig not configured"}
    </span>
  );
}

// String form of the same for the blunt confirm modal (ConfirmRow takes a string).
function feeSplitText(
  split?: { creatorPct: number; platformPct: number; referrerPct: number },
  loading?: boolean,
  configured?: boolean,
): string {
  if (split) return `${split.creatorPct}% / ${split.platformPct}% / ${split.referrerPct}%`;
  if (loading) return "reading…";
  return configured ? "read failed" : "not configured";
}

// Skeleton that mirrors the asset-picker rows exactly, so the panel below the
// treasury toggle is never a bare near-black rectangle while reads are in flight
// (Phase 1 bug 3) and nothing shifts when the real rows land (Phase 3).
function AssetPickerSkeleton() {
  return (
    <div className="grid gap-2" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center justify-between rounded-input border border-border px-3 py-2.5">
          <div className="space-y-1.5">
            <div className="h-3.5 w-16 animate-pulse rounded bg-surface-raised" />
            <div className="h-3 w-24 animate-pulse rounded bg-surface-raised" />
          </div>
          <div className="space-y-1.5 text-right">
            <div className="ml-auto h-3.5 w-16 animate-pulse rounded bg-surface-raised" />
            <div className="ml-auto h-3 w-12 animate-pulse rounded bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── small shared bits ───────────────────────────────────────────────────────
function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="field-label mb-0">
          {label} {optional && <span className="text-text-faint">(optional)</span>}
        </label>
        {hint && <span className="text-xs text-text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function PrefixInput({
  prefix,
  value,
  onChange,
  placeholder,
}: {
  prefix: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center rounded-input border border-border bg-bg focus-within:border-green">
      <span className="pl-3 text-sm text-text-faint">{prefix}</span>
      <input
        className="w-full bg-transparent px-1 py-2.5 text-sm text-text-primary placeholder:text-text-faint focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="text-right font-medium text-text-primary">{children}</span>
    </div>
  );
}

function ConfirmRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className={cn("text-right font-medium text-text-primary", mono && "font-mono")}>{value}</span>
    </div>
  );
}

function StepDot({ status }: { status: string }) {
  if (status === "success") return <span className="mt-0.5 text-green">✓</span>;
  if (status === "error") return <span className="mt-0.5 text-negative">✕</span>;
  // Lost = unknown outcome, not a failure — an amber question mark, never a red X.
  if (status === "lost") return <span className="mt-0.5 text-warning">?</span>;
  if (status === "pending" || status === "confirming")
    return <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-green" />;
  return <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-border" />;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-6 text-center">
      <h2 className="font-semibold text-text-primary">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{children}</p>
    </div>
  );
}

function InlineNotice({ children, tone }: { children: React.ReactNode; tone?: "warning" }) {
  return (
    <p
      className={cn(
        "rounded-input border p-3 text-sm",
        tone === "warning"
          ? "border-warning-border bg-warning-bg text-text-secondary"
          : "border-border bg-bg text-text-muted",
      )}
    >
      {children}
    </p>
  );
}
