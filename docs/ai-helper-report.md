# AI helper (Raeto) — build & test report

Branch `feat/ai-helper`. Frontend/API only, no contracts. **Off by default**
(`NEXT_PUBLIC_AI_HELPER_ENABLED` unset) and **not merged**.

---

## 1. Test-call result (the one tiny call you asked for first)

Two server-side probes, reading the key from `web/.env.local` (the key was never
printed, inlined in a logged command, or committed):

**`GET /v1/me`** → `200`
- `available_usd: 10`, `balance_usd: 10`, `spent_usd: 0`, `limit_usd: 10`
- key name `ballast-prod`, kind `dev`, **`models: ["openai/gpt-4o-mini"]`**

**`POST /v1/chat/completions` with `raeto/auto`** → **`403 model_not_allowed`**
> "This key can only use: openai/gpt-4o-mini."

**`POST /v1/chat/completions` with `openai/gpt-4o-mini`** → `200`
- `x-raeto-model: openai/gpt-4o-mini`
- `x-raeto-tier:` _(absent — Raeto only emits a tier header on auto-routed calls)_
- `x-raeto-cost: 0.00000292` (for a 6-token reply)

### What this means — needs your attention
The key **cannot use `raeto/auto`** — it is scoped to `openai/gpt-4o-mini` only.
Our code handles this exactly as specified: it tries `raeto/auto`, gets the 403,
and **retries once with `openai/gpt-4o-mini`**, which succeeds. So the feature works
today, but **every request routes to gpt-4o-mini; auto-routing/tiering never
engages.** To enable real auto-routing, add `raeto/auto` to this key's allowed
model list (or raise the $RAETO holding) in the Raeto dashboard. No code change is
needed when you do — the auto path is already tried first.

---

## 2. Cost per request

- Measured: `x-raeto-cost` on gpt-4o-mini = **$0.00000292** for a 6-token reply.
- Estimated per real request (gpt-4o-mini, ~$0.15/1M in, ~$0.60/1M out):
  - **/api/ai/suggest** (~500 in + up to 400 out) ≈ **$0.0003**
  - **/api/ai/summary** (~450 in + up to 250 out) ≈ **$0.0002**
- The $10 balance is therefore ~**25k–50k requests**. Summaries are cached per
  token + block bucket (~1 min), so repeat token-page views don't re-bill.
- Every call logs only `status`, `latency`, and the `x-raeto-model / -tier / -cost`
  headers — never prompts or the key. (Visible in the test run output.)

---

## 3. What to provision for rate limiting

Our limits are deliberately well under Raeto's 120 req/min:
- suggest: **8/min per IP and per wallet**
- summary: **20/min per IP**

The limiter is **serverless-safe when Upstash Redis is configured**, and degrades
to a per-instance in-memory limiter otherwise (fine for local/Preview, logs a
one-time warning). For Production, please provision:

1. **Upstash Redis** via the **Vercel Marketplace** (Integrations → Upstash →
   create a free Redis database, link it to this project).
2. Set two server-only env vars (the integration can inject them automatically):
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

With both set, limits hold across lambda instances. The limiter **fails open** on a
Redis error so a blip can't take the feature down (Raeto's own 120/min is the hard
backstop).

---

## 4. Vercel env vars to set (you)

Server-only (no `NEXT_PUBLIC_`): `RAETO_API_KEY` — **Preview scope now; Production
only after you approve.** Plus `UPSTASH_REDIS_REST_URL` / `_TOKEN` for durable
limits.

Client flag: `NEXT_PUBLIC_AI_HELPER_ENABLED=1` on whichever environment(s) you want
the feature visible. Leave unset to keep it fully dark.

(`web/.env.local` already has `RAETO_API_KEY` + `NEXT_PUBLIC_AI_HELPER_ENABLED=1`
for local testing; `.env.local` is gitignored and untracked — verified.)

---

## 5. Tests

`npm test` — **167 passed** (30 new):
- `lib/ai/guardrails.test.ts` — banned-word filter (incl. no false-positives &
  price-prediction hype), brand/ticker blocklist, input validation, structured-hint
  (noticeDays / feeSplitBps) parsing.
- `lib/ai/summaryData.test.ts` — on-chain fact → prompt assembly (backed, unbacked,
  no-router, stale-feed), and that the assembled prompt itself carries no banned copy.
- `lib/ai/raeto.test.ts` — mocked **auto_routing_locked / model_not_allowed →
  gpt-4o-mini fallback**, fallback-also-refused → `models_misconfigured`, and the
  unavailable states (429/402/500/timeout/no-key, `/v1/me` down).

`npm run typecheck` and `npm run build` both clean.

---

## 6. Screenshots

I can't produce **Vercel Preview** screenshots from here — deploying is your step
(division of labour), and it needs `RAETO_API_KEY` set in the Preview env first.
Once you've set the Preview env vars and pushed `feat/ai-helper`, the panel appears
on **/app/create** ("Need ideas?") and the card on a token's **About** tab ("In
plain English"). If you'd like, I can instead capture **local** screenshots against
`next start` with the flag on — say the word.

---

## 7. Guardrails summary (what blocks bad output)

- System prompts forbid: floor / safe / guaranteed / protected / secured / yield /
  insured / returns / passive income / dividend / APR / APY / risk-free, price
  predictions, and any redemption/claim implication; require the "no claim on
  treasury assets" line whenever backing is mentioned.
- **Post-filter** (`lib/ai/guardrails.ts`) re-checks every output and **regenerates
  once, then rejects** to the clean "unavailable" state rather than ship a banned
  word.
- Names/tickers that copy our listed stock tickers (NVDA, SPY, AAPL…), crypto
  majors, or real brands (Apple, Tesla, Robinhood…) are dropped; if none survive,
  the suggestion is rejected.
- Suggestions only ever **fill editable fields** — nothing is signed or submitted.
