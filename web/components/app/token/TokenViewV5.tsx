"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { formatUnits, type Address } from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { erc20Abi, ballastTokenAbi } from "@/lib/abis";
import { ballastFactoryV5Abi, feeRouterV5Abi } from "@/lib/abisV5";
import { FACTORY_ADDRESS, HOOK_ADDRESS, WETH_ADDRESS, POOL_MANAGER_ADDRESS, TOTAL_SUPPLY } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { profile } from "@/lib/chainProfile";
import { poolKeyForToken, poolId as computePoolId, tokenIsCurrency0, tokenPriceInQuote } from "@/lib/pool";
import { readElysiumPoolState } from "@/lib/elysiumQuote";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { ipfsToGateway } from "@/lib/ipfs";
import { SwapPanelV5 } from "@/components/app/SwapPanelV5";
import { LimitOrderPanel } from "@/components/app/LimitOrderPanel";

const CHAIN_ID = activeChain.id;

function fmtPrice(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  if (n === 0) return "0";
  return n.toLocaleString("en", { maximumSignificantDigits: 6 });
}

// Gen-5 (Elysium) token page. No treasury / backing (gen-5 has neither). Shows
// identity, price (from pool state), swap, limit orders, the creator-fee split, and
// the protocol-share disclosure.
export function TokenViewV5({ token }: { token: Address }) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const { data: symbol } = useReadContract({ address: token, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID });
  const { data: name } = useReadContract({ address: token, abi: erc20Abi, functionName: "name", chainId: CHAIN_ID });
  const { data: metadataURI } = useReadContract({
    address: token,
    abi: ballastTokenAbi,
    functionName: "metadataURI",
    chainId: CHAIN_ID,
  });
  const { data: graduated } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: ballastFactoryV5Abi,
    functionName: "graduated",
    args: [token],
    chainId: CHAIN_ID,
    query: { enabled: Boolean(FACTORY_ADDRESS) },
  });
  const { data: swapFeeBps } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: ballastFactoryV5Abi,
    functionName: "swapFeeBpsOf",
    args: [token],
    chainId: CHAIN_ID,
    query: { enabled: Boolean(FACTORY_ADDRESS) },
  });
  const { data: launchIdPlus1 } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: ballastFactoryV5Abi,
    functionName: "launchIdOf",
    args: [token],
    chainId: CHAIN_ID,
    query: { enabled: Boolean(FACTORY_ADDRESS) },
  });
  const { data: launchRow } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: ballastFactoryV5Abi,
    functionName: "launches",
    args: [launchIdPlus1 && (launchIdPlus1 as bigint) > 0n ? (launchIdPlus1 as bigint) - 1n : 0n],
    chainId: CHAIN_ID,
    query: { enabled: Boolean(FACTORY_ADDRESS && launchIdPlus1 && (launchIdPlus1 as bigint) > 0n) },
  });
  const feeRouter = launchRow ? (launchRow as readonly Address[])[1] : undefined;

  const meta = useProjectMeta(typeof metadataURI === "string" ? metadataURI : undefined);
  const logo = meta.meta?.logo ? ipfsToGateway(meta.meta.logo) : undefined;

  // Pool price via extsload.
  const [priceWhype, setPriceWhype] = useState<bigint | undefined>();
  const [hasPool, setHasPool] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const whype = WETH_ADDRESS;
    const manager = POOL_MANAGER_ADDRESS;
    if (!publicClient || !HOOK_ADDRESS || !whype || !manager) return;
    const key = poolKeyForToken(token, whype, HOOK_ADDRESS);
    if (!key) return;
    const pid = computePoolId(key);
    // Retry a few times: a cold/rate-limited RPC (or a transient proxy error right
    // after a dev-compile) can fail the first extsload; a graduated pool always has
    // a readable slot0, so a null/throw here is treated as "not yet", not "no pool".
    (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        try {
          const state = await readElysiumPoolState(publicClient, manager, pid);
          if (cancelled) return;
          if (state) {
            setHasPool(true);
            setPriceWhype(tokenPriceInQuote(state.sqrtPriceX96, tokenIsCurrency0(token, whype), 18));
            return;
          }
        } catch {
          /* transient — retry */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token]);

  const sym = (symbol as string) || "TOKEN";
  const fdvWhype = useMemo(() => {
    if (priceWhype === undefined) return undefined;
    return (priceWhype * TOTAL_SUPPLY) / 10n ** 18n;
  }, [priceWhype]);

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex items-center gap-3">
        {logo ? (
          <Image src={logo} alt="" width={48} height={48} className="h-12 w-12 rounded-md object-cover" unoptimized />
        ) : (
          <div className="h-12 w-12 rounded-md bg-bg-elevated" />
        )}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="font-serif text-xl font-semibold text-bone">{(name as string) || sym}</h1>
            <span className="chip chip-neutral">{sym}</span>
            {profile.label ? <span className="chip chip-accent">{profile.label}</span> : null}
          </div>
          <a
            className="font-mono text-xs text-text-faint hover:text-green"
            href={`${activeChain.blockExplorers?.default.url}/token/${token}`}
            target="_blank"
            rel="noreferrer"
          >
            {token.slice(0, 8)}…{token.slice(-6)}
          </a>
        </div>
      </div>

      {/* stat row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Price (${profile.quoteSymbol})`} value={fmtPrice(priceWhype)} />
        <Stat label={`FDV (${profile.quoteSymbol})`} value={fmtPrice(fdvWhype)} />
        <Stat label="Swap fee" value={swapFeeBps !== undefined ? `${Number(swapFeeBps) / 100}%` : "—"} />
        <Stat label="Status" value={graduated ? "Live" : "Not graduated"} />
      </div>

      {hasPool ? (
        <div className="grid gap-5 md:grid-cols-2">
          <SwapPanelV5 token={token} symbol={sym} hasPool={hasPool} />
          <LimitOrderPanel token={token} symbol={sym} />
        </div>
      ) : (
        <section className="card p-5 text-sm text-text-muted">
          This token has not graduated yet — no pool to trade against.
        </section>
      )}

      {feeRouter ? <FeeSplit feeRouter={feeRouter} /> : null}

      {/* protocol-share disclosure — exact required wording */}
      <p className="note note-neutral text-xs">
        On Elysium, the protocol share accrues to the Ballast Safe (2-of-3) and is used
        for $BALLAST buyback &amp; burn once the bridge is live.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-text-faint">{label}</div>
      <div className="mt-1 text-sm text-text-secondary">{value}</div>
    </div>
  );
}

function FeeSplit({ feeRouter }: { feeRouter: Address }) {
  const base = { address: feeRouter, abi: feeRouterV5Abi, chainId: CHAIN_ID } as const;
  const { data: creatorBps } = useReadContract({ ...base, functionName: "creatorBps" });
  const { data: buybackBps } = useReadContract({ ...base, functionName: "buybackBps" });
  const { data: rewardsBps } = useReadContract({ ...base, functionName: "rewardsBps" });
  const pct = (b: unknown) => (b === undefined ? "—" : `${Number(b) / 100}%`);
  return (
    <section className="card space-y-2 p-5">
      <div className="section-label">Creator fee split</div>
      <Row label="Creator" value={pct(creatorBps)} />
      <Row label="Buyback & burn" value={pct(buybackBps)} />
      <Row label="Rewards" value={pct(rewardsBps)} />
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-secondary">{value}</span>
    </div>
  );
}
