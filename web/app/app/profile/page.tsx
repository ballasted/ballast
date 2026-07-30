"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { useProjects, type Project } from "@/hooks/useProjects";
import { ConnectButton } from "@/components/app/ConnectButton";
import { SocialIcon } from "@/components/SocialIcon";
import { COMMUNITY_LINKS } from "@/lib/links";
import { formatUsd, shortAddress } from "@/lib/format";
import { activeChain } from "@/lib/chain";

export default function ProfilePage() {
  const { address: account, isConnected } = useAccount();
  const { projects, isLoading, isConfigured } = useProjects();

  if (!isConfigured) {
    return <Notice title="Not configured yet" body="Deploy the core contracts and set the factory address to read a track record." />;
  }
  if (!isConnected || !account) {
    return (
      <div className="card p-8 text-center">
        <h1 className="font-semibold text-text-primary">Connect your wallet</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">Your creator track record is read live from the launches this wallet has created.</p>
        <div className="mt-4 flex justify-center"><ConnectButton /></div>
      </div>
    );
  }

  const mine = projects.filter((p) => p.creator.toLowerCase() === account.toLowerCase());
  const stillFunded = mine.filter((p) => p.ballasted).length;
  const totalLocked = mine.reduce((s, p) => s + (p.backing?.lockedValueUsd ?? 0n), 0n);

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-bg font-semibold text-green">
          {account.slice(2, 4).toUpperCase()}
        </div>
        <div>
          <h1 className="font-serif text-xl font-semibold text-bone">{shortAddress(account)}</h1>
          {/* X OAuth isn't wired — anchor to the wallet and say so plainly (spec §9). */}
          <p className="text-xs text-text-muted">
            Wallet identity. Linking an X account (harder to fake than a fresh wallet) comes with the social layer.
          </p>
        </div>
      </header>

      {isLoading ? (
        <div className="card h-24 animate-pulse" />
      ) : (
        <>
          <section className="grid grid-cols-3 gap-3">
            <Stat label="Launched" value={String(mine.length)} />
            <Stat label="Still funded" value={mine.length ? `${stillFunded} of ${mine.length}` : "0"} />
            <Stat label="Locked backing" value={formatUsd(totalLocked, { compact: true })} />
          </section>

          {mine.length === 0 ? (
            <Notice title="No launches yet" body="This wallet hasn't launched a project. When it does, its track record builds here — publicly, from the chain." />
          ) : (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-text-primary">Launches</h2>
              {mine.map((p) => <ProfileLaunch key={p.token} p={p} />)}
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
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-faint">Community</h2>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4 text-center">
      <div className="figure-primary text-xl">{value}</div>
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
            <div className="figure-primary">{formatUsd(p.backing.totalValueUsd, { compact: true })}</div>
            <div className="metric-secondary">{formatUsd(p.backing.lockedValueUsd, { compact: true })} locked</div>
          </>
        ) : (
          <div className="text-xs text-text-faint">Unbacked</div>
        )}
      </div>
    </Link>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <h2 className="font-semibold text-text-primary">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}
