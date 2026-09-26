# Scanner outreach — why Honeypot shows "Unknown," and what to send

## Root cause, confirmed on-chain, not guessed

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

- **GoPlus** — token security API covers a broad multi-chain list; Robinhood
  Chain support status wasn't confirmed one way or the other from their
  public docs at the time of writing. Needs: verified source (already done),
  and likely direct outreach since a brand-new L2 often isn't auto-onboarded.
- **Serialized** (the scanner that produced this report) — already scanning
  this chain and this token; the three flagged items and the "Unknown"
  honeypot status are both addressed by this doc and `PROTOCOL_CONTROLS.md`.
- **GMGN** — aggregates scan results from underlying providers rather than
  running its own v4-hook-aware simulation; whatever it shows is likely
  inherited from one of the others above, not independently fixable by
  contacting GMGN directly.
- **De.Fi** (Shield/REKT database) — multi-chain scanner; Robinhood Chain
  4663 support not confirmed from public docs.

None of these were confirmed to have explicit Uniswap v4 hooked-pool support
documented publicly — v4 hooks are still relatively new, and a hook that
takes a fee via `beforeSwap`/`afterSwap` (rather than a plain ERC-20 transfer
tax) is exactly the kind of mechanism a v3-era honeypot heuristic doesn't
model correctly. This is the most likely SECOND contributor to "Unknown"
alongside the sell-exact-out revert.

## Draft note to send

> Subject: BALLAST ($BALLAST) on Robinhood Chain (4663) — Honeypot: Unknown, context
>
> $BALLAST is a real, currently-sellable token on Robinhood Chain (4663),
> trading through a Uniswap v4 pool with a custom hook
> (`0x9C15c992E4De3711715C8B7D717EF46e474680CC`, verified source on
> Blockscout). We believe the "Unknown" honeypot classification comes from
> two things specific to this chain/pool type, not from the token being
> unsellable:
>
> 1. The hook intentionally does not support sell-exact-out swaps (it reverts
>    with a named error, `SellExactOutNotSupported`, to avoid mis-collecting
>    its fee on a partial fill). Sell-exact-IN works normally and is how
>    every real seller on this token actually trades. If your check includes
>    an exact-out probe, that's the revert you're seeing.
> 2. This is a Uniswap v4 pool with a hook attached (not a plain v2/v3 pool
>    or an ERC-20 transfer tax) — the fee is taken inside the hook's
>    `beforeSwap`/`afterSwap` callbacks. If your simulation assumes a
>    standard AMM without hook support, it may not model this correctly.
>
> Contract source is verified on Blockscout at every address involved
> (token, treasury, hook, factory). Happy to answer anything else needed to
> classify this correctly.

Send this once source verification is confirmed live for the current
generation ($BALLAST's own launch, not just the newest factory) — check via
`GET /api/verify/<address>` on the token before sending, since Blockscout's
own verification (separate from ours) intermittently 403s server-to-server
requests (see the existing note in `route.ts`).
