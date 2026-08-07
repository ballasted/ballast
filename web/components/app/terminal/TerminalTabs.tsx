"use client";

import { useMemo, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import { TradesPanel, HoldersPanel } from "@/components/app/token/TokenSections";
import { ConnectButton } from "@/components/app/ConnectButton";
import { useTrades } from "@/hooks/useTrades";
import { erc20Abi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { formatSmallUsd, formatCompactUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

const CHAIN_ID = activeChain.id;
type Tab = "trades" | "holders" | "top" | "you";
const TABS: { key: Tab; label: string }[] = [
  { key: "trades", label: "Trades" },
  { key: "holders", label: "Holders" },
  { key: "top", label: "Top traders" },
  { key: "you", label: "Your position" },
];

// The under-chart tabs. Trades and Holders reuse the token-page panels wholesale.
// Top traders and Your position are derived from data we already have (the trades
// sample and the connected wallet), each labelled with its real scope — never a
// placeholder, and never a fabricated figure.
export function TerminalTabs({
  token,
  symbol,
  creator,
  treasury,
  priceUsd,
  now,
}: {
  token: Address;
  symbol?: string;
  creator?: Address;
  treasury?: Address;
  priceUsd?: number; // USD per token, for position valuation
  now: number;
}) {
  const [tab, setTab] = useState<Tab>("trades");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 rounded-full border border-border p-0.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs transition-colors",
              tab === t.key ? "bg-green text-bg font-semibold" : "text-text-muted hover:text-text-secondary",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "trades" && <TradesPanel token={token} symbol={symbol} now={now} />}
      {tab === "holders" && <HoldersPanel token={token} creator={creator} treasury={treasury} now={now} />}
      {tab === "top" && <TopTraders token={token} symbol={symbol} />}
      {tab === "you" && <YourPosition token={token} symbol={symbol} priceUsd={priceUsd} />}
    </div>
  );
}

// Aggregate the recent-trades SAMPLE by wallet. Honestly scoped: this is not the full
// history (that needs an indexer), so it's "most active in the recent sample", stated.
function TopTraders({ token, symbol }: { token: Address; symbol?: string }) {
  const { data, isLoading } = useTrades(token);
  const rows = useMemo(() => {
    const by = new Map<string, { wallet: string; volumeUsd: number; buys: number; sells: number }>();
    for (const t of data?.trades ?? []) {
      const cur = by.get(t.wallet) ?? { wallet: t.wallet, volumeUsd: 0, buys: 0, sells: 0 };
      cur.volumeUsd += t.volumeUsd;
      if (t.kind === "buy") cur.buys += 1;
      else cur.sells += 1;
      by.set(t.wallet, cur);
    }
    return [...by.values()].sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 10);
  }, [data]);

  return (
    <section className="card p-5">
      <h2 className="section-label">Top traders</h2>
      {isLoading ? (
        <div className="mt-4 h-9 animate-pulse rounded bg-surface-raised" aria-hidden />
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No trades in the recent sample yet.</p>
      ) : (
        <>
          <ul className="mt-3 space-y-1.5">
            {rows.map((r) => (
              <li key={r.wallet} className="flex items-center justify-between gap-3 text-sm">
                <a
                  href={`${activeChain.blockExplorers.default.url}/address/${r.wallet}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-text-primary hover:text-green"
                >
                  {shortAddress(r.wallet as Address)}
                </a>
                <span className="flex items-center gap-3 tabular-nums">
                  <span className="text-[11px] text-text-faint">
                    {r.buys}B · {r.sells}S
                  </span>
                  <span className="text-text-secondary">{formatCompactUsd(r.volumeUsd)}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[11px] text-text-faint">
            Ranked by volume in the recent-trades sample from GeckoTerminal — not the full history, which would need an
            indexer. B/S is buys vs sells in that sample.
          </p>
        </>
      )}
    </section>
  );
}

// The connected wallet's holding and its current value. NOT P&L — cost basis can't be
// derived from public data without guessing, so we don't show a gain/loss figure.
function YourPosition({ token, symbol, priceUsd }: { token: Address; symbol?: string; priceUsd?: number }) {
  const { address } = useAccount();
  const balRes = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });
  const holding = balRes.data as bigint | undefined;
  const holdingNum = holding !== undefined ? Number(formatUnits(holding, 18)) : undefined;
  const valueUsd = holdingNum !== undefined && priceUsd !== undefined ? holdingNum * priceUsd : undefined;

  return (
    <section className="card p-5">
      <h2 className="section-label">Your position</h2>
      {!address ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ConnectButton />
          <span className="text-xs text-text-faint">Connect a wallet to see your holding.</span>
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <div className="eyebrow">Holding</div>
              <div className="figure-primary mt-0.5 text-lg tabular-nums">
                {holdingNum !== undefined ? holdingNum.toLocaleString("en", { maximumFractionDigits: 2 }) : "…"}{" "}
                <span className="text-sm text-text-faint">${symbol ?? "TOKEN"}</span>
              </div>
            </div>
            <div>
              <div className="eyebrow">Current value</div>
              <div className="figure-primary mt-0.5 text-lg tabular-nums">
                {valueUsd !== undefined ? formatSmallUsd(valueUsd) : "—"}
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-text-faint">
            Holding is read live from chain; value is holding × current price. This is not profit and loss — your cost
            basis can&apos;t be derived from public data without guessing, so we don&apos;t show a gain/loss figure.
          </p>
        </>
      )}
    </section>
  );
}
