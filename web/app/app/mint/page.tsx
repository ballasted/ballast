"use client";

import { useAccount } from "wagmi";
import { useManatee, useManateeArt } from "@/hooks/useManatee";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { ConnectButton } from "@/components/app/ConnectButton";
import { activeChain } from "@/lib/chain";
import { cn } from "@/lib/cn";

const EXPLORER = activeChain.blockExplorers.default.url;

export default function MintPage() {
  const s = useManatee();
  const { isConnected } = useAccount();
  const { wrongNetwork } = useNetworkGuard();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="eyebrow">On-chain collection</p>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Manatee</h1>
        {/* Copy, verbatim to the launch brief — tone matters here. */}
        <div className="mt-3 max-w-2xl space-y-3 text-sm text-text-secondary">
          <p>
            Free to mint, one per wallet. The art is generated on-chain from the token id — there is
            no IPFS and no metadata server. Every manatee is the same drawing; only the depth changes.
            Nothing is rarer than anything else.
          </p>
          <p>
            This confers nothing. No revenue share, no governance, no airdrop, no allocation. If that
            changes, we&apos;ll announce it after it&apos;s true.
          </p>
        </div>
      </header>

      {!s.configured ? (
        <Notice
          title="Not live yet"
          body="The collection isn't deployed here yet. Once it is (and NEXT_PUBLIC_MANATEE_ADDRESS is set), the counter and mint below read live from chain."
        />
      ) : (
        <>
          <Counter minted={s.minted} max={s.maxSupply} loading={s.isLoading} />

          <div className="card card-raised p-5">
            {/* Action area. Each state below is deliberately designed, not a fallthrough. */}
            {!isConnected ? (
              <Stack>
                <p className="text-sm text-text-secondary">Connect a wallet to mint.</p>
                <ConnectButton />
              </Stack>
            ) : wrongNetwork ? (
              <Stack>
                <p className="text-sm text-warning">
                  <span className="font-semibold">Wrong network.</span>{" "}
                  <span className="text-text-secondary">
                    Switch to {activeChain.name} (use the banner above) to mint.
                  </span>
                </p>
                <button className="btn-primary px-5 py-2 text-sm opacity-60" disabled>
                  Mint
                </button>
              </Stack>
            ) : s.hasMinted ? (
              <Minted tokenId={s.myTokenId} txHash={s.phase === "success" ? s.txHash : undefined} />
            ) : s.soldOut ? (
              <Notice
                title="Minted out"
                body="All 1,000 manatees have been minted. The art for every one lives on-chain and can be read from the contract forever."
              />
            ) : (
              <MintAction state={s} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Counter({ minted, max, loading }: { minted?: number; max: number; loading: boolean }) {
  const pct = minted !== undefined && max > 0 ? Math.min(100, (minted / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="section-label">Minted</span>
        <span className="font-mono text-sm text-bone">
          {loading && minted === undefined ? "…" : (minted ?? 0).toLocaleString("en")}{" "}
          <span className="text-text-muted">/ {max.toLocaleString("en")}</span>
        </span>
      </div>
      {/* A plain progress bar — no countdown, no urgency, no "only N left" pressure. */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-green transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MintAction({ state: s }: { state: ReturnType<typeof useManatee> }) {
  const minting = s.phase === "minting";
  return (
    <Stack>
      <p className="text-sm text-text-secondary">
        One manatee, minted to your wallet. Free — you pay only gas.
      </p>
      <button
        onClick={() => void s.mint()}
        disabled={minting}
        className={cn("btn-primary px-6 py-2.5 text-sm", minting && "opacity-70")}
      >
        {minting ? "Minting…" : "Mint"}
      </button>
      {s.phase === "error" && s.error && (
        <p className="note note-warning text-sm">{s.error}</p>
      )}
      {minting && s.txHash && (
        <p className="text-xs text-text-muted">
          Submitted —{" "}
          <a className="underline hover:text-text-secondary" href={`${EXPLORER}/tx/${s.txHash}`} target="_blank" rel="noopener noreferrer">
            track on Blockscout
          </a>
        </p>
      )}
    </Stack>
  );
}

// The wallet has a manatee. Prove the on-chain art works by rendering the piece
// straight from the contract's own view — not a local copy.
function Minted({ tokenId, txHash }: { tokenId?: number; txHash?: `0x${string}` }) {
  const art = useManateeArt(tokenId);
  return (
    <Stack>
      <div className="flex items-center gap-2">
        <span className="chip chip-accent">Minted</span>
        {tokenId != null && <span className="font-mono text-sm text-bone">#{tokenId}</span>}
      </div>

      <div className="relative aspect-square w-full max-w-sm overflow-hidden rounded-card border border-border bg-card">
        {art.svg ? (
          // Rendered as an <img> data URI: the SVG never enters our DOM as active
          // markup, and it comes from our own immutable renderer, read live.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(art.svg)}`}
            alt={tokenId != null ? `Manatee #${tokenId}` : "Your manatee"}
            className="h-full w-full"
          />
        ) : art.error ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-text-muted">
            Couldn&apos;t read the art just now — it&apos;s safe on-chain. Refresh to try again.
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-text-muted">
            {tokenId == null ? "Finding your manatee…" : "Reading the art from chain…"}
          </div>
        )}
      </div>

      <p className="text-sm text-text-secondary">
        This is your manatee, drawn on-chain from its token id. It&apos;s the same image the
        contract returns to any marketplace — no server involved.
      </p>
      {txHash && (
        <p className="text-xs text-text-muted">
          <a className="underline hover:text-text-secondary" href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noopener noreferrer">
            View mint on Blockscout
          </a>
        </p>
      )}
    </Stack>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-start gap-3">{children}</div>;
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="note note-neutral">
      <p className="font-medium text-text-primary">{title}</p>
      <p className="mt-1 text-sm text-text-secondary">{body}</p>
    </div>
  );
}
