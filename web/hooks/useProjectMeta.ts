"use client";

import { useEffect, useState } from "react";
import { ipfsToGateway, type ProjectMetadata } from "@/lib/ipfs";

// Fetches a token's pinned metadata JSON (from its on-chain metadataURI) through
// a public gateway. Module-level cache dedupes repeats across cards/pages. The
// on-chain URI is the source of truth; this only resolves its content for display.
const cache = new Map<string, ProjectMetadata | null>();

export function useProjectMeta(uri?: string) {
  const [meta, setMeta] = useState<ProjectMetadata | undefined>(
    uri && cache.has(uri) ? cache.get(uri) ?? undefined : undefined,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!uri) {
      setMeta(undefined);
      return;
    }
    if (cache.has(uri)) {
      setMeta(cache.get(uri) ?? undefined);
      return;
    }
    const gw = ipfsToGateway(uri);
    if (!gw) return;
    let cancelled = false;
    setLoading(true);
    fetch(gw)
      .then((r) => (r.ok ? (r.json() as Promise<ProjectMetadata>) : null))
      .then((j) => {
        if (cancelled) return;
        cache.set(uri, j);
        setMeta(j ?? undefined);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        cache.set(uri, null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return { meta, loading };
}

// Batch variant: fetch metadata for a whole list of projects (Discover) so the board
// can filter by category — the category lives in each project's pinned metadata JSON,
// not on-chain, so it's sourceable without an indexer (spec 1.5). Shares the same
// module cache as useProjectMeta, so cards that later mount don't refetch. Returns a
// map keyed by lowercased token address; a token is absent until its metadata lands.
export function useProjectsMeta(
  items: { token: string; metadataURI?: string }[],
): Map<string, ProjectMetadata | null> {
  const uriKey = items.map((p) => p.metadataURI ?? "").join(",");
  const [, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const missing = items.filter((p) => p.metadataURI && !cache.has(p.metadataURI));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (p) => {
        const gw = ipfsToGateway(p.metadataURI);
        if (!gw) {
          cache.set(p.metadataURI!, null);
          return;
        }
        try {
          const r = await fetch(gw);
          cache.set(p.metadataURI!, r.ok ? ((await r.json()) as ProjectMetadata) : null);
        } catch {
          cache.set(p.metadataURI!, null);
        }
      }),
    ).then(() => {
      if (!cancelled) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
    // uriKey captures the set of URIs; re-run only when that set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uriKey]);

  const map = new Map<string, ProjectMetadata | null>();
  for (const p of items) {
    if (p.metadataURI && cache.has(p.metadataURI)) {
      map.set(p.token.toLowerCase(), cache.get(p.metadataURI) ?? null);
    }
  }
  return map;
}
