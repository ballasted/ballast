import "server-only";

// Shared Bearer auth for the indexer's privileged routes (migrate/backfill/cron).
// Same convention the Telegram poll route uses: accept `Authorization: Bearer
// <CRON_SECRET>` (Vercel Cron sends this) OR an `x-cron-secret` header. If
// CRON_SECRET is unset, nothing is authorized — the route must 401. The secret is
// read BY NAME only and never logged.
export function cronAuthed(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = req.headers.get("authorization");
  if (bearer && bearer === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}
