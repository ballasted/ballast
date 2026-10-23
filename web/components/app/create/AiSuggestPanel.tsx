"use client";

import { useState } from "react";
import { useAiStatus, useAiSuggest, type SuggestFormState } from "@/hooks/useAiHelper";
import type { FeeSplitBpsSuggestion } from "@/lib/ai/guardrails";
import { cn } from "@/lib/cn";

// "Need ideas?" helper for the Create flow. A one-line idea becomes 3 name/ticker
// options + a description you click to fill, plus optional one-click Apply for a
// notice preset and a fee split. Suggestions ONLY — every value lands in an
// editable field; nothing is signed or submitted here. Renders nothing unless the
// feature flag is on AND the server reports the key has funds.

type Props = {
  form: SuggestFormState;
  wallet?: string;
  onApplyName: (v: string) => void;
  onApplyTicker: (v: string) => void;
  onApplyDescription: (v: string) => void;
  onApplyNoticeDays: (d: 7 | 30 | 90) => void;
  onApplyFeeSplit: (bps: FeeSplitBpsSuggestion) => void;
};

function splitLabel(b: FeeSplitBpsSuggestion): string {
  // Treasury is always 0 (unsupported bucket) — omit it. Show only non-zero buckets.
  const p = (bps: number) => Math.round((bps / 10000) * 100);
  const parts = [`creator ${p(b.creatorBps)}`];
  if (b.buybackBps > 0) parts.push(`buyback ${p(b.buybackBps)}`);
  if (b.rewardsBps > 0) parts.push(`stakers ${p(b.rewardsBps)}`);
  return parts.join(" · ");
}

export function AiSuggestPanel(props: Props) {
  const status = useAiStatus();
  const { run, loading, error, suggestion, reset } = useAiSuggest();
  const [open, setOpen] = useState(false);
  const [idea, setIdea] = useState("");

  // Flag off, or key out of funds → nothing renders (Create flow is untouched).
  if (!status.enabled || !status.available) return null;

  const rateLimited = error?.retryAfterSec !== undefined;

  return (
    <section className="card-raised p-4" aria-label="AI launch helper">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-label">Need ideas?</h2>
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            if (open) reset();
          }}
          className="text-xs text-text-faint underline underline-offset-2 hover:text-text-secondary"
        >
          {open ? "Hide" : "Open"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input"
              placeholder="One line: what's your launch about?"
              value={idea}
              maxLength={280}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && idea.trim().length >= 3 && !loading) run(idea.trim(), props.form, props.wallet);
              }}
            />
            <button
              type="button"
              className="btn-primary whitespace-nowrap sm:w-auto"
              disabled={loading || idea.trim().length < 3}
              onClick={() => run(idea.trim(), props.form, props.wallet)}
            >
              {loading ? "Thinking…" : "Suggest"}
            </button>
          </div>

          {error && (
            <div className={cn("note", rateLimited ? "note-warning" : "note-neutral")} role="status">
              {rateLimited
                ? `Too many requests — try again in ${error.retryAfterSec}s.`
                : error.message}
            </div>
          )}

          {suggestion && (
            <div className="space-y-4">
              <Row label="Names">
                <div className="flex flex-wrap gap-2">
                  {suggestion.names.map((n) => (
                    <Pill key={n} onClick={() => props.onApplyName(n)}>
                      {n}
                    </Pill>
                  ))}
                </div>
              </Row>

              <Row label="Ticker">
                <div className="flex flex-wrap gap-2">
                  {suggestion.tickers.map((t) => (
                    <Pill key={t} onClick={() => props.onApplyTicker(t)}>
                      ${t}
                    </Pill>
                  ))}
                </div>
              </Row>

              <Row label="Description">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-text-secondary">{suggestion.description}</p>
                  <button type="button" className="chip chip-accent shrink-0" onClick={() => props.onApplyDescription(suggestion.description)}>
                    Apply
                  </button>
                </div>
              </Row>

              {suggestion.pairingSuggestion && (
                <Row label="Pairing">
                  <p className="text-sm text-text-muted">{suggestion.pairingSuggestion}</p>
                </Row>
              )}

              {suggestion.noticeDays && (
                <Row label="Notice">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-text-secondary tabular-nums">{suggestion.noticeDays} days</span>
                    <button
                      type="button"
                      className="chip chip-accent shrink-0"
                      onClick={() => props.onApplyNoticeDays(suggestion.noticeDays!)}
                    >
                      Apply
                    </button>
                  </div>
                </Row>
              )}

              {suggestion.feeSplitBps && (
                <Row label="Fee split">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-text-secondary tabular-nums">{splitLabel(suggestion.feeSplitBps)}</span>
                    <button
                      type="button"
                      className="chip chip-accent shrink-0"
                      onClick={() => props.onApplyFeeSplit(suggestion.feeSplitBps!)}
                    >
                      Apply
                    </button>
                  </div>
                </Row>
              )}

              {suggestion.reasoning && <p className="text-xs text-text-faint">{suggestion.reasoning}</p>}
            </div>
          )}

          <p className="text-[10px] uppercase tracking-[0.18em] text-text-faint">Powered by Raeto</p>
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Pill({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tab tab-idle min-h-[44px] !py-1 hover:border-green hover:text-green md:!min-h-0"
    >
      {children}
    </button>
  );
}
