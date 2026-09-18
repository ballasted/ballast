"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useProjects, type Project } from "@/hooks/useProjects";
import { WalletGate } from "@/components/app/WalletGate";
import { SocialIcon } from "@/components/SocialIcon";
import { CopyAddress } from "@/components/app/CopyAddress";
import { COMMUNITY_LINKS } from "@/lib/links";
import { formatUsd, shortAddress } from "@/lib/format";
import { activeChain } from "@/lib/chain";
import { cn } from "@/lib/cn";

type LaunchFilter = "all" | "ballasted" | "unbacked";

export default function ProfilePage() {
  const [filter, setFilter] = useState<LaunchFilter>("all");
  const { address: account, isConnected } = useAccount();
  const { projects, isLoading, isConfigured } = useProjects();

  if (!isConfigured) {
    return <Notice title="Not configured yet" body="Set the factory address (after deploy) to read a track record." />;
  }
  if (!isConnected || !account) {
    return <WalletGate body="Your track record reads live from this wallet's launches." />;
  }

  const mine = projects.filter((p) => p.creator.toLowerCase() === account.toLowerCase());
  const stillFunded = mine.filter((p) => p.ballasted).length;
  const totalLocked = mine.reduce((s, p) => s + (p.backing?.lockedValueUsd ?? 0n), 0n);
  const totalTreasury = mine.reduce((s, p) => s + (p.backing?.totalValueUsd ?? 0n), 0n);
  const filtered =
    filter === "all" ? mine : filter === "ballasted" ? mine.filter((p) => p.ballasted) : mine.filter((p) => !p.ballasted);

  return (
    <div className="space-y-5">
      <section className="card flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-bg font-semibold text-green ring-1 ring-inset ring-bone/10">
            {account.slice(2, 4).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-serif text-lg font-semibold text-bone">Profile</h1>
              <span className="chip chip-accent">Connected</span>
            </div>
            <CopyAddress address={account} label={shortAddress(account)} className="mt-0.5" />
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="eyebrow">Locked backing</div>
          <div className="mt-0.5 flex items-baseline gap-2 sm:justify-end">
            <span data-balance className="figure-primary text-4xl">
              {formatUsd(totalLocked, { compact: true })}
            </span>
          </div>
          <div className="metric-secondary">across {mine.length} launch{mine.length === 1 ? "" : "es"}</div>
        </div>
      </section>

      {isLoading ? (
        <div className="card h-24 animate-pulse" />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Launched" value={String(mine.length)} />
            <Stat label="Ballasted" value={mine.length ? `${stillFunded} of ${mine.length}` : "0"} />
            <Stat label="Locked backing" value={formatUsd(totalLocked, { compact: true })} balance />
            <Stat label="Total treasury" value={formatUsd(totalTreasury, { compact: true })} balance />
          </section>

          {mine.length === 0 ? (
            <Notice title="Nothing yet." />
          ) : (
            <section className="space-y-3">
              <div className="flex gap-2">
                {(["all", "ballasted", "unbacked"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)} className={cn("tab", filter === f ? "tab-active" : "tab-idle")}>
                    {f === "all" ? "All launches" : f === "ballasted" ? "Ballasted" : "Unbacked"}
                  </button>
                ))}
              </div>
              {filtered.length === 0 ? (
                <Notice title="Nothing yet." />
              ) : (
                filtered.map((p) => <ProfileLaunch key={p.token} p={p} />)
              )}
            </section>
          )}

          <a
            href={`${activeChain.blockExplorers.default.url}/address/${account}`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-text-faint hover:text-text-secondary"
          >
            View this wallet on Blockscout ↗
          </a>
        </>
      )}

      <CommunityLinks />
    </div>
  );
}

// Community/social links in the app, kept OUT of the five-slot bottom nav. Same
// central config the marketing footer uses; distinct labels for the two Telegrams.
function CommunityLinks() {
  return (
    <section className="border-t border-border pt-4">
      <h2 className="eyebrow font-semibold">Community</h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
        {COMMUNITY_LINKS.map((l) =>
          l.external ? (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
            >
              <SocialIcon name={l.icon} />
              {l.label}
            </a>
          ) : (
            <Link
              key={l.href}
              href={l.href}
              className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
            >
              <SocialIcon name={l.icon} />
              {l.label}
            </Link>
          ),
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, balance }: { label: string; value: string; balance?: boolean }) {
  return (
    <div className="card p-4 text-center">
      <div data-balance={balance ? true : undefined} className="figure-primary text-xl">
        {value}
      </div>
      <div className="metric-secondary">{label}</div>
    </div>
  );
}

function ProfileLaunch({ p }: { p: Project }) {
  return (
    <Link href={`/app/token/${p.token}`} className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-text-faint">
      <div className="min-w-0">
        <div className="font-semibold text-text-primary">{p.symbol ?? "—"}</div>
        <div className="metric-secondary">{p.name ?? "Unnamed project"}</div>
      </div>
      <div className="text-right">
        {p.ballasted && p.backing ? (
          <>
            <div data-balance className="figure-primary">{formatUsd(p.backing.totalValueUsd, { compact: true })}</div>
            <div data-balance className="metric-secondary">{formatUsd(p.backing.lockedValueUsd, { compact: true })} locked</div>
          </>
        ) : (
          <div className="text-xs text-text-faint">Unbacked</div>
        )}
      </div>
    </Link>
  );
}

function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <div className="card p-8 text-center">
      <h2 className="font-semibold text-text-primary">{title}</h2>
      {body && <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>}
    </div>
  );
}
