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
