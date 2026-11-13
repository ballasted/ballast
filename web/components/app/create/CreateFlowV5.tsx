"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import Image from "next/image";
import { ConnectButton } from "@/components/app/ConnectButton";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useLaunchRunnerV5, type LaunchParamsV5, type StepStatus } from "@/hooks/useLaunchRunnerV5";
import { WETH_ADDRESS } from "@/lib/contracts";
import { profile } from "@/lib/chainProfile";
import { activeChain } from "@/lib/chain";
import { pinJson, pinFile, resizeImage, isAcceptedImage } from "@/lib/ipfs";

// Gen-5 (Elysium) create flow. Deliberately sparse (CLAUDE.md UI principles): no
// treasury, no backing, no notice period. One quote asset (WHYPE). The creator sets
// a swap fee that is FIXED FOREVER at launch and a FeeRouterV5 split; liquidity is
// locked forever at graduation.

const SYMBOL_RE = /[^A-Z0-9]/g;

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "success") return <span className="mt-0.5 text-green">✓</span>;
  if (status === "error") return <span className="mt-0.5 text-negative">✕</span>;
  if (status === "lost") return <span className="mt-0.5 text-warning">?</span>;
  if (status === "pending" || status === "confirming")
    return <span className="mt-0.5 animate-pulse text-text-muted">●</span>;
  return <span className="mt-0.5 text-text-faint">○</span>;
}

export function CreateFlowV5() {
  const { address: account } = useAccount();
  const { wrongNetwork, switchToActive, isSwitching, targetChainName } = useNetworkGuard();
  const runner = useLaunchRunnerV5();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [logoUri, setLogoUri] = useState("");
  const [logoPreview, setLogoPreview] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();

  // Swap fee 1%–10%, whole percent. Fixed forever at launch.
  const [feePct, setFeePct] = useState(1);
  // FeeRouterV5 split (whole percent), must sum to 100. Default: all to creator.
  const [creatorPct, setCreatorPct] = useState(100);
  const [buybackPct, setBuybackPct] = useState(0);
  const [rewardsPct, setRewardsPct] = useState(0);

  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>();

  const symbolClean = symbol.toUpperCase().replace(SYMBOL_RE, "").slice(0, 11);
  const splitSum = creatorPct + buybackPct + rewardsPct;
  const feeOk = feePct >= 1 && feePct <= 10;
  const splitOk = splitSum === 100 && [creatorPct, buybackPct, rewardsPct].every((n) => n >= 0 && n <= 100);
  const formValid = name.trim().length > 0 && symbolClean.length > 0 && feeOk && splitOk;

  async function onLogo(file: File | undefined) {
    setUploadError(undefined);
    if (!file) return;
    if (!isAcceptedImage(file)) {
      setUploadError("Use a PNG, JPG, or WebP (no SVG).");
      return;
    }
    setUploading(true);
    try {
      const resized = await resizeImage(file, 512);
      setLogoPreview(URL.createObjectURL(resized));
      const uri = await pinFile(resized, "logo.png");
      setLogoUri(uri);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function launch() {
    if (!formValid) return;
    setPinError(undefined);
    setPinning(true);
    try {
      const quoteAsset = WETH_ADDRESS; // WHYPE on Elysium
      if (!quoteAsset) throw new Error("WHYPE quote asset not configured");
      const metadataURI = await pinJson({
        name: name.trim(),
        symbol: symbolClean,
        description: description.trim() || undefined,
        logo: logoUri.trim() || undefined,
      });
      setPinning(false);
      const params: LaunchParamsV5 = {
        name: name.trim(),
        symbol: symbolClean,
        metadataURI,
        swapFeeBps: Math.round(feePct * 100),
        quoteAsset,
        creatorBps: creatorPct * 100,
        buybackBps: buybackPct * 100,
        rewardsBps: rewardsPct * 100,
      };
      void runner.run(params);
    } catch (e) {
      setPinning(false);
      setPinError(e instanceof Error ? e.message : "Could not prepare the launch");
    }
  }

  const explorer = activeChain.blockExplorers?.default.url;
  const running = runner.isRunning || pinning;
  const errorStep = runner.steps.find((s) => s.status === "error");

  const launchDisabled = useMemo(
    () => !formValid || running || !account || wrongNetwork,
    [formValid, running, account, wrongNetwork],
  );

  return (
    <div className="space-y-5">
      {profile.label ? (
        <span className="chip chip-accent w-fit">{profile.label}</span>
      ) : null}

      {/* Identity */}
      <section className="card space-y-4 p-5">
        <div className="section-label">Token</div>
        <div className="flex gap-4">
          <label className="flex h-20 w-20 flex-none cursor-pointer items-center justify-center overflow-hidden rounded-md border border-hairline bg-bg-elevated text-xs text-text-faint hover:border-green">
            {logoPreview ? (
              <Image src={logoPreview} alt="logo" width={80} height={80} className="h-full w-full object-cover" />
            ) : uploading ? (
              "…"
            ) : (
              "Image"
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => void onLogo(e.target.files?.[0])}
            />
          </label>
          <div className="flex-1 space-y-3">
            <input
              className="input"
              placeholder="Name"
              value={name}
              maxLength={48}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="input uppercase"
              placeholder="TICKER"
              value={symbolClean}
              onChange={(e) => setSymbol(e.target.value)}
            />
          </div>
        </div>
        {uploadError ? <p className="text-xs text-negative">{uploadError}</p> : null}
        <textarea
          className="input min-h-[80px] resize-y"
          placeholder="Description (optional)"
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
      </section>

      {/* Pair + fee */}
      <section className="card space-y-4 p-5">
        <div className="section-label">Pair &amp; fee</div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">Paired with</span>
          <span className="chip chip-neutral">{profile.quoteSymbol}</span>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">Swap fee</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                className="input w-20 text-right"
                value={feePct}
                onChange={(e) => setFeePct(Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 0))))}
              />
              <span className="text-text-muted">%</span>
            </div>
          </div>
          <p className="note note-warning text-xs">
            The swap fee is fixed forever at launch. It cannot be changed afterwards.
          </p>
        </div>
      </section>

      {/* Fee split */}
      <section className="card space-y-3 p-5">
        <div className="section-label">Creator fee split</div>
        <SplitRow label="Creator" value={creatorPct} onChange={setCreatorPct} />
        <SplitRow label="Buyback & burn" value={buybackPct} onChange={setBuybackPct} />
        <SplitRow label="Rewards" value={rewardsPct} onChange={setRewardsPct} />
        <div className={`flex justify-between text-xs ${splitOk ? "text-text-faint" : "text-negative"}`}>
          <span>Total</span>
          <span>{splitSum}%</span>
        </div>
      </section>

      <p className="note note-neutral text-xs">
        Liquidity is locked forever at graduation. On {activeChain.name}, the protocol
        share accrues to the Ballast Safe (2-of-3) and is used for $BALLAST buyback
        &amp; burn once the bridge is live.
      </p>

      {/* Action */}
      <section className="card p-5">
        {!account ? (
          <div className="flex justify-center">
            <ConnectButton />
          </div>
        ) : wrongNetwork ? (
          <button className="btn-primary w-full" onClick={() => void switchToActive()} disabled={isSwitching}>
            {isSwitching ? "Switching…" : `Switch to ${targetChainName}`}
          </button>
        ) : (
          <button className="btn-primary w-full" onClick={() => void launch()} disabled={launchDisabled}>
            {pinning ? "Preparing…" : runner.isRunning ? "Launching…" : "Launch"}
          </button>
        )}
        {pinError ? <p className="mt-2 text-xs text-negative">{pinError}</p> : null}
      </section>

      {/* Steps */}
      {runner.steps.length > 0 ? (
        <section className="card space-y-2 p-5">
          <div className="section-label">Progress</div>
          {runner.steps.map((s) => (
            <div key={s.key} className="flex items-start gap-2 text-sm">
              <StepIcon status={s.status} />
              <div className="flex-1">
                <span className={s.status === "error" ? "text-negative" : "text-text-secondary"}>{s.label}</span>
                {s.txHash && explorer ? (
                  <a
                    className="ml-2 text-xs text-text-faint underline hover:text-green"
                    href={`${explorer}/tx/${s.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx
                  </a>
                ) : null}
                {s.error ? <p className="text-xs text-negative">{s.error}</p> : null}
              </div>
            </div>
          ))}
          {errorStep ? (
            <button className="btn-secondary mt-2 w-full" onClick={() => runner.launched && void launch()}>
              Retry
            </button>
          ) : null}
        </section>
      ) : null}

      {runner.result ? (
        <section className="card space-y-2 p-5 text-sm">
          <div className="text-green">Launched.</div>
          <a className="text-text-secondary underline hover:text-green" href={`/app/token/${runner.result.token}`}>
            View token
          </a>
        </section>
      ) : null}
    </div>
  );
}

function SplitRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          className="input w-20 text-right"
          value={value}
          onChange={(e) => onChange(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
        />
        <span className="text-text-muted">%</span>
      </div>
    </div>
  );
}
