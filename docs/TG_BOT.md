# Telegram notification bot

Posts on-chain Ballast activity to a Telegram channel: new launches, buys/sells on
Ballast pools (≥ `TG_MIN_SWAP_ETH`), platform buyback & burn, large manual
$BALLAST burns to the dead address (≥ `TG_MIN_BURN`), fee-split scheduled/applied
(FeeRouter v2), parent burns, treasury deposits, and basket fills.

Endpoint: `GET /api/tg/poll` — protected by `CRON_SECRET`. One run reads at most
2,000 blocks and sends at most ~15 messages (overflow collapses to one digest).
State (last processed block + `txHash:logIndex` dedup, 7-day TTL) lives in the
existing Upstash KV. **The first run starts at the current tip — history is never
backfilled into the channel.**

## 1. Create the bot + channel

1. In Telegram, message **@BotFather** → `/newbot` → copy the token → set
   `TELEGRAM_BOT_TOKEN` in Vercel (never commit it).
2. Create your channel, add the bot as an **admin** (so it can post).
3. Set `TELEGRAM_CHAT_ID`: `@yourchannel` for a public channel, or the numeric id
   (e.g. `-100…`) for a private one. (Tip: temporarily set `TG_DRY_RUN=true` and
   call the endpoint to confirm wiring without posting.)

## 2. Vercel env vars

| var | value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from BotFather (secret) |
| `TELEGRAM_CHAT_ID` | channel id / @handle |
| `TG_BOT_ENABLED` | `true` to allow posting |
| `TG_DRY_RUN` | `true` to log instead of send (testing) |
| `TG_MIN_SWAP_ETH` | default `0.01` |
| `TG_MIN_BURN` | default `100000` |
| `CRON_SECRET` | a long random string |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | the existing Upstash KV (already set for the AI limiter) |
| `RPC_UPSTREAM_URL` | optional dedicated RPC (falls back to the public one) |

## 3. Scheduling — pick ONE (depends on your Vercel plan)

**Vercel Cron (Pro and up — per-minute allowed).** Add to `web/vercel.json`:

```json
{ "crons": [ { "path": "/api/tg/poll", "schedule": "* * * * *" } ] }
```

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET`
is set. **This file is intentionally NOT committed** — a per-minute cron fails
validation on the Hobby plan, which would break deploys. Add it only once you're on
Pro.

**Upstash QStash (works on Hobby).** Create a schedule that calls the endpoint
every minute with the secret header:

```bash
curl -X POST https://qstash.upstash.io/v2/schedules/https://www.ballasted.fun/api/tg/poll \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: * * * * *" \
  -H "Upstash-Forward-Authorization: Bearer $CRON_SECRET"
```

(The `Upstash-Forward-*` header is forwarded to our endpoint as `Authorization`.)

## 4. Verify

- `TG_DRY_RUN=true`, then `curl -H "Authorization: Bearer $CRON_SECRET" https://<preview>/api/tg/poll`.
  The first call returns `{ firstRun: true }` (seeds the cursor, posts nothing).
  Subsequent calls log any decoded messages to the function logs.
- Flip `TG_DRY_RUN=false` to go live.

## Notes / limits

- Swaps are posted only for **WETH-quoted pools** (the ETH threshold applies there);
  the pool→token map is built from `PoolSeeded` events and cached in KV.
- Manual-burn posts track **$BALLAST v2** transfers to the dead address only.
- Copy follows the project rules: no price/market-cap in v1; burns are always
  "sent to the dead address"; no "yield/reward/floor/guaranteed/safe".
- Decoders mirror `packages/sdk` (`parseBallastLogs`) but import the web app's own
  ABIs so the Vercel build stays self-contained.
