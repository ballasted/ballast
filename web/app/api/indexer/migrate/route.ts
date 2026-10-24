import { NextResponse } from "next/server";
import { cronAuthed } from "@/lib/indexer/auth";
import { getMigrationDb, isMigrationConfigured } from "@/lib/indexer/db";
import { MIGRATIONS } from "@/lib/indexer/migrations";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Runs pending migrations idempotently over the UNPOOLED (direct) connection.
// Applied migration names are tracked in schema_migrations; a migration already
// recorded there is skipped. Every statement is itself IF NOT EXISTS, so a partial
// prior run (recorded or not) re-applies cleanly.
export async function POST(req: Request) {
  if (!cronAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isMigrationConfigured()) return NextResponse.json({ error: "database not configured" }, { status: 503 });

  const pool = getMigrationDb();
  if (!pool) return NextResponse.json({ error: "database not configured" }, { status: 503 });

  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Ensure the bookkeeping table exists (first statement of the first migration
    // also creates it, but create it up front so we can read it safely).
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const done = (await pool.query(`SELECT name FROM schema_migrations`)) as { rows: Array<{ name: string }> };
    const doneSet = new Set(done.rows.map((r) => r.name));

    for (const migration of MIGRATIONS) {
      if (doneSet.has(migration.name)) {
        skipped.push(migration.name);
        continue;
      }
      for (const stmt of migration.statements) {
        await pool.query(stmt);
      }
      await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [
        migration.name,
      ]);
      applied.push(migration.name);
    }
    return NextResponse.json({ ok: true, applied, skipped });
  } catch (e) {
    console.error("[indexer/migrate] failed", (e as Error).message);
    return NextResponse.json({ ok: false, error: "migration failed", applied, skipped }, { status: 500 });
  } finally {
    await pool.end().catch(() => {});
  }
}
