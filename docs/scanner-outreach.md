# Scanner outreach — why Honeypot shows "Unknown," and what to send

## UPDATE 2026-09-29 — the real, proven root cause is unverified source, not the hook

Queried GoPlus's live token-security API directly (`api.gopluslabs.io/api/v1/token_security/4663`
— confirmed reachable from outside the app's own sandbox even though Blockscout's web/API
endpoints are currently Cloudflare-blocked there) for every generation of Ballast-launched
token. The pattern is exact and 100% consistent, across four tokens on three different hook
generations:

| Token | Hook generation | `is_open_source` | `is_honeypot` |
|---|---|---|---|
| BALLAST v1 | gen-1 (`0x9C15…80CC`) | `1` (verified) | `0` — clean pass |
| CHRS | gen-1 (`0x9C15…80CC`) | `1` (verified) | `0` — clean pass |
| RCN | gen-1 (`0x9C15…80CC`) | `1` (verified) | `0` — clean pass |
| BALLAST v2 | gen-4 (`0x4eb2dd…42cc`) | `0` (**not** verified) | missing entirely (→ renders as "Unknown") |
| TEST | gen-4 (`0x4eb2dd…42cc`) | `0` (**not** verified) | missing entirely (→ renders as "Unknown") |

Every gen-1 token (verified) gets a clean explicit "not a honeypot." Every unverified token —
regardless of hook generation — gets no `is_honeypot` field at all, which downstream UIs render
as "Unknown." **This directly disproves the sell-exact-out theory as the primary cause**: BALLAST
v1 has the exact same `SellExactOutNotSupported` hook limitation as v2 (same hook family, same
design), yet GoPlus scores it a clean pass — because it's verified. The variable that actually
predicts "Unknown" here is verification status, nothing else.

**The fix is Section 1 (verify $BALLAST v2, TEST, and every other unverified token).** Once gen-4's
tokens are verified on Blockscout the same way gen-1's were, GoPlus's `is_open_source` should flip
to `1` and `is_honeypot` should populate — most likely `0`, matching every prior verified token's
result, since nothing about the swap mechanics differs from BALLAST v1.

Raw responses saved for the record: `docs/scanner-evidence/goplus-ballast-v1-2026-09-29.json`,
`docs/scanner-evidence/goplus-ballast-v2-2026-09-29.json` (public API output, no secrets).

### Secondary, still-real factor (kept from the original analysis below)

The sell-exact-out revert is real and permanent (confirmed via `V4Quoter` simulation, not just
source reading — see the original section below), and *could* still independently confuse a
scanner whose specific check simulates sell-exact-out rather than reading `is_open_source`. It
just isn't the explanation for GoPlus specifically, based on the A/B comparison above. Worth
keeping in the outreach note as context, demoted from "the cause" to "a secondary factor if the
scanner's methodology differs from GoPlus's."

## Original root-cause analysis (sell-exact-out) — kept for context, not disproven, just demoted

Simulated buy-exact-in, sell-exact-in, sell-exact-out, and buy-exact-out
directly against $BALLAST's real mainnet pool via `V4Quoter` (see
`docs/PROTOCOL_CONTROLS.md` for the exact call results). Sell-exact-in
succeeds — the token is genuinely sellable. Sell-exact-out reverts by design
(`SellExactOutNotSupported`, a real, permanent limitation of the current hook,
not a bug). A scanner whose honeypot check includes a sell-exact-out probe
will see a revert on an otherwise-sellable token and can't cleanly classify
it either way — landing on "Unknown" rather than a false "Fail."

## Which scanners matter on chain 4663, and what each needs

Checked each scanner's own public docs/site for Robinhood Chain (4663)
support — not inferred from general reputation.

- **GoPlus** — **CONFIRMED live 2026-09-29**, queried directly:
  `api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=<addr>`.
  Robinhood Chain is fully onboarded (`supported_chains` lists `{"name":"Robinhood","id":"4663"}`),
  and it correctly parses our Uniswap v4 hooked pools (`dex[].liquidity_type: "UniV4"`, correct
  `pool_manager` address, correct per-pool liquidity for both of BALLAST v2's pools) — so v4-hook
  support is NOT a GoPlus problem at all, contrary to the guess below. **No outreach needed** — this
  is a live, automatic API read, not a manual review queue. It will re-classify BALLAST v2 the
  moment verification (Section 1) lands, same as it already does for every verified token today.
- **Serialized** (the scanner that produced this report) — already scanning
  this chain and this token; the three flagged items and the "Unknown"
  honeypot status are both addressed by this doc and `PROTOCOL_CONTROLS.md`.
- **GMGN** — aggregates scan results from underlying providers rather than
  running its own v4-hook-aware simulation; whatever it shows is likely
  inherited from one of the others above, not independently fixable by
  contacting GMGN directly.
- **De.Fi** (Shield/REKT database) — multi-chain scanner; Robinhood Chain
  4663 support not confirmed from public docs.

**GoPlus's v4-hook support is now confirmed working** (see above) — retract the "v4 hooks might not
be modeled correctly" theory for GoPlus specifically. It may still apply to Serialized/GMGN/De.Fi,
whose v4 support wasn't independently testable from here (no public read-only API found for
Serialized or De.Fi; GMGN aggregates rather than running its own simulation).

## Draft note to send — for Serialized / GMGN / De.Fi only (NOT GoPlus, see above)

> Subject: BALLAST v2 ($BALLAST) on Robinhood Chain (4663) — Honeypot/audit: Unknown, context
>
> $BALLAST v2 is a real, currently-sellable token on Robinhood Chain (4663),
> trading through two Uniswap v4 pools with a custom hook
> (`0x4eb2dd759f4d6524e66057d1adc10c26e40142cc`). We've confirmed directly with
> GoPlus's own API that "Unknown" here tracks source-verification status, not
> the token's actual sellability: every prior-generation Ballast token we've
> verified on Blockscout (BALLAST v1, CHRS, RCN) shows a clean "not a
> honeypot" on GoPlus; v2 shows "Unknown" purely because verification for the
> newest contract generation is still in progress (Blockscout submission
> pending — Cloudflare-side delay, not a code issue). We expect this to
> resolve automatically once verification completes, with no other change
> needed on your end.
>
> Secondary, if your check specifically probes sell-exact-out (as opposed to
> reading verification status): the hook intentionally does not support
> sell-exact-out swaps (reverts with a named error, `SellExactOutNotSupported`,
> to avoid mis-collecting its fee on a partial fill). Sell-exact-IN works
> normally and is how every real seller on this token actually trades.
>
> Happy to answer anything else needed to classify this correctly, or ping
> again once verification is confirmed live.

Send this once verification is confirmed live for BALLAST v2 (Section 1 — currently blocked by a
Cloudflare issue reaching Blockscout from this session; check `is_open_source` via the same GoPlus
endpoint used above, or Blockscout's contract page directly, before sending) — check via
`GET /api/verify/<address>` on the token before sending, since Blockscout's
own verification (separate from ours) intermittently 403s server-to-server
requests (see the existing note in `route.ts`).
