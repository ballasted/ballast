"use client";

import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useProjects } from "@/hooks/useProjects";
import { BurnVoteCard } from "@/components/app/token/BurnVoteCard";
import { isBurnVoteConfigured, isHiddenToken } from "@/lib/contracts";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

// Burn-to-vote hub: pick a token, see its stock options + tallies this week, and
// vote. Voting burns the token to the dead address (irrecoverable); the card
// itself states this. Winners come from on-chain events only. Gated behind
// NEXT_PUBLIC_BURN_VOTE — the page shows an inert notice until BurnVote is live.
export default function VotePage() {
  const { projects, isLoading } = useProjects();
  const tokens = useMemo(
    () => projects.filter((p) => !isHiddenToken(p.token)),
    [projects],
  );
  const [selected, setSelected] = useState<Address | undefined>(undefined);
  const active = selected ?? tokens[0]?.token;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Vote</h1>
        <p className="max-w-prose text-sm text-text-muted">
          Burn a token to vote for its community&apos;s default round-up stock. Tokens used to vote
          are sent to the dead address and cannot be recovered. Results come from on-chain votes
          only.
        </p>
      </header>

      {!isBurnVoteConfigured ? (
        <div className="note note-neutral">Burn-to-vote is not live yet.</div>
      ) : (
        <>
          {tokens.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {tokens.map((p) => {
                const on = active?.toLowerCase() === p.token.toLowerCase();
                return (
                  <button
                    key={p.token}
                    type="button"
                    onClick={() => setSelected(p.token)}
                    className={cn(
                      "chip",
                      on ? "chip-accent" : "chip-neutral",
                    )}
                  >
                    {p.symbol ? `$${p.symbol}` : shortAddress(p.token)}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="note note-neutral">
              {isLoading ? "Loading tokens…" : "No tokens to vote on yet."}
            </div>
          )}

          {active ? <BurnVoteCard token={active} /> : null}
        </>
      )}
    </div>
  );
}
