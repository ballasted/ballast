"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { useProjects, type Project } from "@/hooks/useProjects";
import { useAssets } from "@/hooks/useAssets";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useDenylist } from "@/hooks/useDenylist";
import { useBasketHistory } from "@/hooks/useBasketHistory";
import { useRamsesPosition } from "@/hooks/useRamsesPosition";
import { AssetDisc } from "@/components/app/AssetDisc";
import { MotionSection } from "@/components/app/MotionSection";
import { ipfsToGateway } from "@/lib/ipfs";
import { formatUsd, formatBackingPerToken, shortAddress } from "@/lib/format";
import { isBasketConfigured, isHiddenToken, isRetiredToken, WETH_ADDRESS } from "@/lib/contracts";
import { projectTreasuryAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { cn } from "@/lib/cn";
import { Card, Stat, Skeleton, Segmented } from "@/components/ui";

const CHAIN_ID = activeChain.id;

type SortId = "backing" | "locked" | "newest";
type FilterId = "all" | "backed" | "unbacked";

const SORTS: { id: SortId; label: string }[] = [
  { id: "backing", label: "Verified backing" },
  { id: "locked", label: "Locked forever" },
  { id: "newest", label: "Newest" },
];
const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "backed", label: "Has backing" },
  { id: "unbacked", label: "No backing" },
];

// The public treasury directory — every launch that has a ProjectTreasury,
// including ones holding $0 so far. Reads ONLY on-chain state (factory launches
// + BackingLens), never the connected wallet, so a visitor with no wallet sees
// the full list. Each row links to its own full backing page
// (/app/backing/[address]), readable by anyone.
export default function BackingIndexPage() {
  const { projects, isLoading, isConfigured, error } = useProjects();
  const { assets } = useAssets();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortId>("backing");
  const [filter, setFilter] = useState<FilterId>("all");

  // Ticker lookup for the pairing + held-asset chips, resolved once and shared.
  const symbolByAddress = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assets) if (a.symbol) m.set(a.address.toLowerCase(), a.symbol);
    if (WETH_ADDRESS) m.set(WETH_ADDRESS.toLowerCase(), "WETH");
    return m;
  }, [assets]);

  // Every launch that actually has a treasury — the honest denominator. Order is
  // the registry's chronological order (useProjects emits ascending), kept stable
  // here so the pending-withdrawal multicall below doesn't refetch on sort/filter.
  const withTreasury = useMemo(
    () => projects.filter((p) => p.hasTreasury && !isHiddenToken(p.token) && !isRetiredToken(p.token)),
    [projects],
  );

  // Aggregate summary row (moved here from /app/treasury, which is now the Open
  // Treasury page). Retired tokens are already excluded above, so they never
  // reach the counts or totals.
  const summary = useMemo(() => {
    const backed = withTreasury.filter((p) => p.ballasted);
    const verified = withTreasury.reduce((a, p) => a + (p.backing?.totalValueUsd ?? 0n), 0n);
    const locked = withTreasury.reduce((a, p) => a + (p.backing?.lockedValueUsd ?? 0n), 0n);
    return { verified, locked, treasuries: withTreasury.length, backed: backed.length };
  }, [withTreasury]);

  // Pending-withdrawal flag per treasury, batched once over the stable list.
  const pendingRes = useReadContracts({
    allowFailure: true,
    contracts: withTreasury.map(
      (p) => ({ address: p.treasury, abi: projectTreasuryAbi, functionName: "pendingWithdrawal", chainId: CHAIN_ID }) as const,
    ),
    query: liveQuery(withTreasury.length > 0),
  });
  const pendingByTreasury = useMemo(() => {
    const m = new Map<string, boolean>();
    withTreasury.forEach((p, i) => {
      const r = pendingRes.data?.[i];
      if (r?.status === "success") {
        const [id] = r.result as unknown as [bigint, Address, bigint, bigint];
        m.set(p.treasury.toLowerCase(), id > 0n);
      }
    });
    return m;
  }, [withTreasury, pendingRes.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return withTreasury.filter((p) => {
      if (filter === "backed" && !p.ballasted) return false;
      if (filter === "unbacked" && p.ballasted) return false;
      if (!q) return true;
      return (p.symbol ?? "").toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q);
    });
  }, [withTreasury, query, filter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "newest") return copy.reverse();
    const key = (p: Project) =>
      sort === "locked" ? (p.backing?.lockedValueUsd ?? 0n) : (p.backing?.totalValueUsd ?? 0n);
    return copy.sort((a, b) => {
      const d = key(b) - key(a);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
  }, [filtered, sort]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Backing</h1>
        <p className="mt-1 max-w-xl text-sm text-text-muted">
          Every Ballast launch has an on-chain treasury. Creators can fill it with listed stock tokens, valued live.
        </p>
      </div>

      {isConfigured && !error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryStat label="Verified backing" value={formatUsd(summary.verified, { compact: true })} loading={isLoading} />
          <SummaryStat label="Locked forever" value={formatUsd(summary.locked, { compact: true })} accent loading={isLoading} />
          <SummaryStat label="Treasuries" value={String(summary.treasuries)} loading={isLoading} />
          <SummaryStat label="With backing" value={String(summary.backed)} loading={isLoading} />
        </div>
      )}

      <input
        className="input max-w-sm"
        placeholder="Search by ticker or name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="Sort treasuries"
          options={SORTS.map((s) => ({ value: s.id, label: s.label }))}
          value={sort}
          onChange={setSort}
          size="sm"
        />
        <Segmented
          ariaLabel="Filter treasuries"
          options={FILTERS.map((f) => ({ value: f.id, label: f.label }))}
          value={filter}
          onChange={setFilter}
          size="sm"
        />
      </div>

      {!isConfigured ? (
        <div className="card p-6 text-center text-sm text-text-muted">
          Backing lens isn&apos;t configured on this deployment.
        </div>
      ) : error ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">Couldn&apos;t load treasuries.</p>
          <button className="btn-secondary mt-4" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <SkeletonGrid />
      ) : sorted.length === 0 ? (
        <div className="card p-6 text-center text-sm text-text-muted">
          {withTreasury.length === 0 ? "No launch has a treasury yet." : "No match."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map((p) => (
            <MotionSection key={p.token}>
              <BackingIndexCard
                project={p}
                symbolByAddress={symbolByAddress}
                hasPending={pendingByTreasury.get(p.treasury.toLowerCase()) ?? false}
              />
            </MotionSection>
          ))}
        </div>
      )}

      <p className="rounded-input bg-card px-3 py-2 text-xs text-text-muted">
        Holding a token gives no claim, redemption right, or entitlement to treasury assets.
      </p>
    </div>
  );
}

function SummaryStat({ label, value, accent, loading }: { label: string; value: string; accent?: boolean; loading?: boolean }) {
  return (
    <Card padded={false} className="p-4">
      <Stat
        label={label}
        value={loading ? <Skeleton width={80} height={22} /> : value}
        valueClassName={cn("text-ui-lg", accent && !loading && "text-green")}
      />
    </Card>
  );
}

function BackingIndexCard({
  project,
  symbolByAddress,
  hasPending,
}: {
  project: Project;
  symbolByAddress: Map<string, string>;
  hasPending: boolean;
}) {
  const { symbol, name, backing, token, quoteAssets } = project;
  const { meta } = useProjectMeta(project.metadataURI);
  const { isDenied } = useDenylist();
  const denied = isDenied(token);
  const logo = ipfsToGateway(denied ? undefined : meta?.logo);

  const basket = useBasketHistory(token);
  const ramses = useRamsesPosition(token);

  const pair = quoteAssets.map((a) => symbolByAddress.get(a.toLowerCase()) ?? shortAddress(a)).join(" · ");
  const heldAssets = ((backing?.assets as unknown as { asset: Address }[]) ?? [])
    .map((a) => symbolByAddress.get(a.asset.toLowerCase()))
    .filter((s): s is string => Boolean(s));

  return (
    <Link href={`/app/backing/${token}`} className="card card-hover flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <AssetDisc src={logo} symbol={symbol} size={40} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-text-primary">{symbol ?? shortAddress(token)}</div>
          <div className="truncate text-sm text-text-muted">{denied ? "Metadata withheld" : (name ?? shortAddress(token))}</div>
        </div>
      </div>

      {pair && (
        <div>
          <div className="eyebrow">Pair</div>
          <div className="truncate text-sm text-text-secondary">{pair}</div>
        </div>
      )}

      <div>
        <div className="eyebrow">Backing per token</div>
        <div className="figure-primary text-xl tabular-nums">{formatBackingPerToken(backing?.backingPerToken ?? 0n)}</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="eyebrow text-green">Locked forever</div>
          <div className="tabular-nums text-sm text-text-secondary">{formatUsd(backing?.lockedValueUsd ?? 0n, { compact: true })}</div>
        </div>
        <div>
          <div className="eyebrow">Creator-withdrawable</div>
          <div className="tabular-nums text-sm text-text-secondary">{formatUsd(backing?.withdrawableValueUsd ?? 0n, { compact: true })}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span className={cn("chip", project.ballasted ? "chip-accent" : "chip-neutral")}>
          {project.ballasted ? formatUsd(backing?.totalValueUsd ?? 0n, { compact: true }) : "No backing"}
        </span>
        {hasPending && <span className="chip chip-warning">Withdrawal pending</span>}
        {heldAssets.slice(0, 3).map((s) => (
          <span key={s} className="chip chip-neutral">{s}</span>
        ))}
        {isBasketConfigured && basket.hasHistory && <span className="chip chip-accent">Basket</span>}
        {ramses.position && <span className="chip chip-accent">Ramses locked</span>}
      </div>
    </Link>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} height={192} rounded="rounded-card-lg" />
      ))}
    </div>
  );
}
