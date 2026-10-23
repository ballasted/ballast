"use client";

import type { Address } from "viem";
import { useAiStatus, useAiSummary } from "@/hooks/useAiHelper";

// "In plain English" — an AI-generated summary of the token's ON-CHAIN data
// (treasury backing, fee split, notice period), fetched lazily and cached per
// token+block server-side. Clearly labelled as AI-generated so it's never mistaken
// for an authoritative figure. Renders nothing unless the flag is on and the key
// has funds.

export function PlainEnglishCard({ token }: { token: Address }) {
  const status = useAiStatus();
  const { summary, loading, error, run } = useAiSummary(token, /* auto */ true);

  if (!status.enabled || !status.available) return null;

  const rateLimited = error?.retryAfterSec !== undefined;

  return (
    <section className="card p-5" aria-label="AI-generated summary">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-label">In plain English</h2>
        <span className="chip chip-neutral">AI</span>
      </div>

      <div className="mt-3 min-h-[2.5rem]">
        {loading && <div className="h-4 w-3/4 animate-pulse rounded bg-border" aria-label="Loading summary" />}

        {!loading && summary && <p className="text-sm leading-relaxed text-text-secondary">{summary}</p>}

        {!loading && !summary && error && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-text-muted">
              {rateLimited ? `Too many requests — try again in ${error.retryAfterSec}s.` : "AI helper is unavailable right now."}
            </span>
            {!rateLimited && (
              <button
                type="button"
                className="chip chip-neutral shrink-0 inline-flex min-h-[44px] items-center px-3 md:min-h-0 md:px-2"
                onClick={run}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <p className="mt-3 text-[10px] uppercase tracking-[0.18em] text-text-faint">
        AI-generated summary of on-chain data. Check the details below. Powered by Raeto.
      </p>
    </section>
  );
}
