"use client";

import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { ballastHookAbi, feeConfigAbi, assetRegistryAbi, timelockAbi } from "@/lib/abis";
import { ASSET_REGISTRY_ADDRESS, hookForFactory } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";

const CHAIN_ID = activeChain.id;

// "Protocol controls" — same spirit as the creator-withdrawal banner: every
// remaining admin power, live from chain, not a static claim. See
// docs/PROTOCOL_CONTROLS.md for the full accounting and the plan to move
// these behind a timelock. Pending-operation detection is deliberately NOT
// attempted (needs CallScheduled event history the free-tier RPC can't scan
// — see the note there) rather than faked.
export function ProtocolControlsPanel({ ownerFactory }: { ownerFactory?: Address }) {
  const hook = hookForFactory(ownerFactory);

  const hookRes = useReadContract({
    address: hook,
    abi: ballastHookAbi,
    functionName: "feeConfig",
    chainId: CHAIN_ID,
    query: liveQuery(Boolean(hook)),
  });
  const feeConfig = hookRes.data as Address | undefined;

  const ownerRes = useReadContracts({
    allowFailure: true,
    contracts: [
      ...(feeConfig ? [{ address: feeConfig, abi: feeConfigAbi, functionName: "owner", chainId: CHAIN_ID } as const] : []),
      ...(ASSET_REGISTRY_ADDRESS ? [{ address: ASSET_REGISTRY_ADDRESS, abi: assetRegistryAbi, functionName: "owner", chainId: CHAIN_ID } as const] : []),
    ],
    query: liveQuery(Boolean(feeConfig) || Boolean(ASSET_REGISTRY_ADDRESS)),
  });
  const feeConfigOwner = feeConfig && ownerRes.data?.[0]?.status === "success" ? (ownerRes.data[0].result as Address) : undefined;
  const registryOwnerIdx = feeConfig ? 1 : 0;
  const registryOwner =
    ASSET_REGISTRY_ADDRESS && ownerRes.data?.[registryOwnerIdx]?.status === "success"
      ? (ownerRes.data[registryOwnerIdx].result as Address)
      : undefined;

  // Detect "is this owner a timelock" by probing getMinDelay() — a plain EOA
  // or a non-timelock contract simply fails this call (allowFailure).
  const delayRes = useReadContracts({
    allowFailure: true,
    contracts: [
      ...(feeConfigOwner ? [{ address: feeConfigOwner, abi: timelockAbi, functionName: "getMinDelay", chainId: CHAIN_ID } as const] : []),
      ...(registryOwner ? [{ address: registryOwner, abi: timelockAbi, functionName: "getMinDelay", chainId: CHAIN_ID } as const] : []),
    ],
    query: liveQuery(Boolean(feeConfigOwner) || Boolean(registryOwner)),
  });
  const feeConfigDelay = feeConfigOwner && delayRes.data?.[0]?.status === "success" ? (delayRes.data[0].result as bigint) : undefined;
  const registryDelayIdx = feeConfigOwner ? 1 : 0;
  const registryDelay =
    registryOwner && delayRes.data?.[registryDelayIdx]?.status === "success" ? (delayRes.data[registryDelayIdx].result as bigint) : undefined;

  if (!feeConfig && !ASSET_REGISTRY_ADDRESS) return null;

  return (
    <section className="card p-4">
      <h2 className="section-label">Protocol controls</h2>
      <p className="mt-1 text-xs text-text-muted">
        The only functions anyone can still change after deploy. Everything else (the factory, the seeder, the
        hook&apos;s fee logic) has no admin function at all — verified from source.
      </p>
      <ul className="mt-3 space-y-3 text-sm">
        <Row
          label="Swap fee + split"
          detail="Up to 10% (hard-capped), 3-way split"
          owner={feeConfigOwner}
          delay={feeConfigDelay}
        />
        <Row label="Platform fee vault" detail="Where the platform's share is sent" owner={feeConfigOwner} delay={feeConfigDelay} />
        <Row label="Referrer allowlist" detail="Who can earn the referrer share" owner={feeConfigOwner} delay={feeConfigDelay} />
        <Row label="Treasury asset allowlist" detail="Which assets can back a launch" owner={registryOwner} delay={registryDelay} />
      </ul>
      <a
        href="/docs/protocol-controls"
        className="mt-3 inline-block text-xs text-text-faint underline underline-offset-2 hover:text-text-secondary"
      >
        Full accounting →
      </a>
    </section>
  );
}

function Row({
  label,
  detail,
  owner,
  delay,
}: {
  label: string;
  detail: string;
  owner?: Address;
  delay?: bigint;
}) {
  const isTimelock = delay !== undefined;
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-text-primary">{label}</div>
        <div className="text-xs text-text-faint">{detail}</div>
      </div>
      <div className="shrink-0 text-right">
        {!owner ? (
          <span className="chip chip-neutral">—</span>
        ) : isTimelock ? (
          <span className="chip chip-accent" title={owner}>
            Timelock · {formatDelay(delay)} delay
          </span>
        ) : (
          <span className="chip chip-warning" title={owner}>
            Direct EOA — not yet timelocked
          </span>
        )}
      </div>
    </li>
  );
}

function formatDelay(seconds: bigint): string {
  const days = Number(seconds) / 86400;
  return Number.isInteger(days) ? `${days}-day` : `${Math.round(Number(seconds) / 3600)}h`;
}
