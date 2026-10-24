import "server-only";
import { neon, neonConfig, Pool, type NeonQueryFunction } from "@neondatabase/serverless";

// Read-only Postgres (Neon) access for the indexer. Import-safe: NO connection is
// ever opened at module load, and when no DB env is set every helper returns
// null/[]/undefined so callers transparently fall back to their current chain/API
// data sources. `next build` with every DB env unset must pass.
//
// Env (provisioned on Vercel Prod + Preview, NOT local dev). Read BY NAME only —
// values are never logged:
//   reads      → DATABASE_URL (pooled)           | fallback POSTGRES_URL
//   migrations → DATABASE_URL_UNPOOLED (direct)  | fallback POSTGRES_URL_NON_POOLING
//
// Pool queries are routed over HTTP fetch (poolQueryViaFetch) so migrations run as
// individual idempotent statements with no WebSocket constructor required in the
// Node serverless runtime.
neonConfig.poolQueryViaFetch = true;

export type Sql = NeonQueryFunction<false, false>;

function readUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

function migrateUrl(): string | undefined {
  return (
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING ||
    readUrl()
  );
}

/** True when a pooled read URL is configured. Cheap, no connection. */
export function isIndexerConfigured(): boolean {
  return Boolean(readUrl());
}

/** True when a URL usable for migrations is configured. */
export function isMigrationConfigured(): boolean {
  return Boolean(migrateUrl());
}

let readClient: Sql | null = null;

/** Pooled HTTP read client, or null if unconfigured. Never throws at import. */
export function getReadDb(): Sql | null {
  const url = readUrl();
  if (!url) return null;
  if (!readClient) readClient = neon(url);
  return readClient;
}

/**
 * Unpooled (direct) connection pool for migrations/writes. Returns null if
 * unconfigured. Caller owns the lifecycle and must `await pool.end()`.
 */
export function getMigrationDb(): Pool | null {
  const url = migrateUrl();
  if (!url) return null;
  return new Pool({ connectionString: url });
}

/**
 * Parameterized read against the pooled client. Returns null when the indexer is
 * unconfigured (so callers fall back), [] when configured but empty. A genuine
 * query error still rejects — callers wrap in try/catch and fall back on throw.
 */
export async function query<T>(text: string, params: ReadonlyArray<unknown> = []): Promise<T[] | null> {
  const sql = getReadDb();
  if (!sql) return null;
  // neon()'s function form: sql(queryText, params) runs a single parameterized
  // query and resolves to the rows array (arrayMode/fullResults both false).
  const rows = await sql(text, params as unknown[]);
  return rows as unknown as T[];
}
