"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AI_HELPER_ENABLED } from "@/lib/ai/config";
import type { SuggestionShape } from "@/lib/ai/guardrails";

// Client hooks for the AI helper. All of them no-op when the feature flag is off,
// so importing them is safe everywhere — nothing fires and nothing renders.

export type AiStatus = { enabled: boolean; available: boolean; loading: boolean };

/** Whether the AI entry points should render: flag on AND the server reports the
 *  key has funds. Fails closed (available:false) on any error. */
export function useAiStatus(): AiStatus {
  const [state, setState] = useState<AiStatus>({ enabled: AI_HELPER_ENABLED, available: false, loading: AI_HELPER_ENABLED });

  useEffect(() => {
    if (!AI_HELPER_ENABLED) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai/status", { cache: "no-store" });
        const j = (await res.json()) as { enabled?: boolean; available?: boolean };
        if (!cancelled) setState({ enabled: Boolean(j.enabled), available: Boolean(j.available), loading: false });
      } catch {
        if (!cancelled) setState({ enabled: true, available: false, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export type SuggestFormState = {
  name?: string;
  symbol?: string;
  category?: string;
  description?: string;
};

export type AiError = { message: string; code?: string; retryAfterSec?: number };

export type UseAiSuggest = {
  run: (idea: string, form: SuggestFormState, wallet?: string) => Promise<void>;
  loading: boolean;
  error: AiError | null;
  suggestion: SuggestionShape | null;
  reset: () => void;
};

export function useAiSuggest(): UseAiSuggest {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AiError | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionShape | null>(null);
  const inflight = useRef(false);

  const run = useCallback(async (idea: string, form: SuggestFormState, wallet?: string) => {
    if (!AI_HELPER_ENABLED || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea, form, wallet }),
      });
      const j = (await res.json()) as { suggestion?: SuggestionShape; error?: string; code?: string; retryAfterSec?: number };
      if (!res.ok || !j.suggestion) {
        setError({ message: j.error ?? "AI helper is unavailable right now.", code: j.code, retryAfterSec: j.retryAfterSec });
        setSuggestion(null);
      } else {
        setSuggestion(j.suggestion);
      }
    } catch {
      setError({ message: "AI helper is unavailable right now." });
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setSuggestion(null);
  }, []);

  return { run, loading, error, suggestion, reset };
}

export type UseAiSummary = {
  summary: string | null;
  loading: boolean;
  error: AiError | null;
  run: () => void;
};

/** Fetches the plain-English summary for a token. Lazy: only fires when `run()` is
 *  called (so viewing a token page doesn't auto-bill Raeto) unless `auto` is set. */
export function useAiSummary(token?: string, auto = false): UseAiSummary {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AiError | null>(null);
  const inflight = useRef(false);

  const run = useCallback(() => {
    // Guard only CONCURRENT calls — a finished call may be retried after an error.
    if (!AI_HELPER_ENABLED || !token || inflight.current || summary) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/ai/summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const j = (await res.json()) as { summary?: string; error?: string; code?: string };
        if (!res.ok || !j.summary) {
          setError({ message: j.error ?? "AI helper is unavailable right now.", code: j.code });
        } else {
          setSummary(j.summary);
        }
      } catch {
        setError({ message: "AI helper is unavailable right now." });
      } finally {
        setLoading(false);
        inflight.current = false;
      }
    })();
  }, [token, summary]);

  useEffect(() => {
    if (auto) run();
  }, [auto, run]);

  return { summary, loading, error, run };
}
