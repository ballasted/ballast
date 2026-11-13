"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { useProjects } from "@/hooks/useProjects";
import { openTreasuryVaultFactoryAbi } from "@/lib/abis";
import {
  OPEN_TREASURY_FACTORY_ADDRESS,
  isOpenTreasuryEnabled,
  isHiddenToken,
  isRetiredToken,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { AssetDisc } from "@/components/app/AssetDisc";
import { MotionSection } from "@/components/app/MotionSection";
import { shortAddress } from "@/lib/format";
import { Skeleton } from "@/components/ui";

const CHAIN_ID = activeChain.id;
const ZERO = "0x0000000000000000000000000000000000000000";

// Open Treasury directory — the public face of the permissionless
// community-deposit vaults. Anyone can deposit a listed stock token into a
// launch's vault; the deposit/withdraw/claim controls themselves live on each
// launch's backing page (OpenTreasurySection), so this page is a read-only
// index that explains the feature and links into each vault. Reads on-chain
// only — no wallet required.
export default function TreasuryPage() {
  const { projects, isLoading } = useProjects();

  const tokens = useMemo(
    () => projects.filter((p) => !isHiddenToken(p.token) && !isRetiredToken(p.token)),
    [projects],
  );

  // Which launches have actually created an Open Treasury vault. vaultOf is a
  // pure read (getOrCreateVault only runs from an explicit deposit), so a token
  // with no vault simply reads address(0).
  const vaultRes = useReadContracts({
    allowFailure: true,
    contracts: tokens.map(
      (p) =>
        ({ address: OPEN_TREASURY_FACTORY_ADDRESS, abi: openTreasuryVaultFactoryAbi, functionName: "vaultOf", args: [p.token], chainId: CHAIN_ID }) as const,
    ),
    query: liveQuery(isOpenTreasuryEnabled && Boolean(OPEN_TREASURY_FACTORY_ADDRESS) && tokens.length > 0),
  });

  const withVault = useMemo(() => {
    return tokens.filter((_p, i) => {
      const r = vaultRes.data?.[i];
      return r?.status === "success" && (r.result as Address)?.toLowerCase() !== ZERO;
    });
  }, [tokens, vaultRes.data]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Treasury</h1>
        <p className="mt-1 max-w-xl text-sm text-text-muted">
          Anyone can deposit a listed stock token into a launch&apos;s Open Treasury vault, withdrawable after 24 hours.
          Rewards — the creator&apos;s share of trading fees — stream to depositors over 7 days and can be zero.{" "}
          <Link href="/docs" className="underline underline-offset-2 hover:text-text-secondary">
            Docs
          </Link>
        </p>
      </div>

      {!isOpenTreasuryEnabled ? (
        <div className="card p-6 text-center text-sm text-text-muted">Open Treasury isn&apos;t live on this deployment yet.</div>
      ) : isLoading ? (
        <SkeletonGrid />
      ) : withVault.length === 0 ? (
        <div className="card p-6 text-center text-sm text-text-muted">No launch has an open treasury vault yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {withVault.map((p) => (
            <MotionSection key={p.token}>
              <Link href={`/app/backing/${p.token}`} className="card card-hover flex items-center gap-3 p-4">
                <AssetDisc symbol={p.symbol} size={40} />
                <div className="min-w-0">
                  <div className="truncate font-semibold text-text-primary">{p.symbol ?? shortAddress(p.token)}</div>
                  <div className="truncate text-sm text-text-muted">{p.name ?? shortAddress(p.token)}</div>
                </div>
              </Link>
            </MotionSection>
          ))}
        </div>
      )}

      {/* Required disclaimer — kept verbatim (project copy rules). */}
      <p className="rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
        Holding a token gives no claim, redemption right, or entitlement to treasury assets.
      </p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} height={80} rounded="rounded-card-lg" />
      ))}
    </div>
  );
}
