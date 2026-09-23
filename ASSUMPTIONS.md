# ASSUMPTIONS — multi stock pair work, 2026-09-23

## Scope change from the pasted brief

The pasted `BALLAST_MULTI_PAIR_BUILD.md` brief (BallastQuoteRegistry + STOCK→USDG→TOKEN
2-hop routing) was written without repo access and assumed the wrong architecture.
This branch already has the real mechanism, built but not deployed:

- `605eb27` "Multiple stock pairs: one launch, several quote-asset pools" —
  `BallastFactory.launch()` takes 1–4 `quoteAssets_`, each `weth` or a deploy-time
  fixed GREEN asset (`isGreenQuoteAsset`), and `graduate()` seeds a DIRECT
  `TOKEN/quoteAsset` pool per entry (no USDG intermediary, no multi-hop router
  work needed for the "10 stock pairs" goal).
- `41ef950` — the create-flow's quote-asset picker (`useQuoteAssets`) and treasury
  asset picker (`useAssets`) are ALREADY fully live-chain-driven (read
  `isGreenQuoteAsset`/`AssetRegistry.allowedAssets()` directly) — no static
  `assets.ts` config file, no new `AssetPicker` component needed. Adding a static
  config would have contradicted this and CLAUDE.md's "read owner-settable globals
  live" convention.

So §5, §6, §8.1, §8.2, §9 (as originally written) of the pasted brief were dropped
entirely; only its 20-asset table, disc/logo assets, and the two-picker split
concept carried over — the disc/AssetDisc component and tickerLogos.ts already
existed and needed only new logo files, not a rebuild.

## GREEN quote-asset list (confirmed by user, overriding the brief's list of 10)

`docs/exit-liquidity-table.md` (2026-09-17, this repo's own liquidity analysis)
recommends only **SGOV, NVDA, SPY** as GREEN — AMZN is RED (no direct WETH pool
at all, a structural no-exit risk), and TSLA/GOOGL/AAPL/META/QQQ/MSFT are AMBER
(held pending a real Quoter-simulated re-review). The user confirmed the
conservative 3-asset list over the brief's "all 10" instruction, which would have
put AMZN live as a quote asset against the table's own explicit recommendation.

`contracts/script/DeployMainnet.s.sol` **already** hardcodes exactly
`GREEN = [SGOV, NVDA, SPY]` passed to `BallastFactory`'s constructor — no change
needed there. Confirmed via forge trace + direct reads:
- `isGreenQuoteAsset` is write-once (constructor only, no setter) — immutable.
- `Launch.quoteAssets` is write-once (`launch()` only, no updater anywhere in
  `BallastFactory`) — immutable per launch, same guarantee as `noticePeriod`.

## RPC access — corrected this session

The public Robinhood Chain RPC (`https://rpc.mainnet.chain.robinhood.com`) IS
reachable from this sandbox (verified live: `eth_chainId`, `eth_blockNumber`,
`web/scripts/setAssets.ts` dry-run, `web/scripts/checkTickerLogos.ts`, `cast call`
against live mainnet contracts all worked). A prior session's memory note saying
RPC was fully blocked was stale/about a different (paid/keyed) endpoint — updated
in the memory file.

However, that free public endpoint has a very short state-retention window
(observed: a single `anvil --fork-url` session failed to fetch `BallastSeeder`'s
state within seconds of forking, both via separate `cast send` calls and within
one `forge script` run) — it is **not viable for a multi-step local fork test**.
Confirmed working in isolation on the fork: fresh `BallastFactory` deploy,
`launch()` with a single non-WETH GREEN quote asset, and a direct
`PoolManager.initialize()` call, all as real broadcast transactions. The
`graduate()` → `BallastSeeder.seed()` step could not be exercised end-to-end from
here. `contracts/script/probe/ProveMultiQuoteSwap.s.sol` is written and compiles;
run it against a stable/paid RPC (`RH_RPC_URL_PAID`) to finish this proof.

Deploying (anything needing `DEPLOYER_PRIVATE_KEY`) remains human-only regardless
of RPC reachability — that was never actually an RPC limitation, it's CLAUDE.md's
"never handle secrets" division of labor.

## Live on-chain state confirmed this session (read-only)

- Current `NEXT_PUBLIC_FACTORY_ADDRESS` (`0x05aaa5c5...`) and the prior factory
  (`0x069974...`) both revert on `MAX_QUOTE_ASSETS()` — the new multi-quote-asset
  factory has **not** been deployed to mainnet yet. Matches prior memory.
- `AssetRegistry.allowedAssets()` returns exactly the 10 batch-1 assets today
  (SGOV/NVDA/TSLA/GOOGL/AAPL/MSFT/AMZN/META/SPY/QQQ). Batch 2 is not yet added.

## Batch-2 treasury allowlist (→ 16, not 20 — see below)

UPDATE 2026-09-23: sourced and independently verified over RPC (not from memory,
not from the brief). Method: found each candidate token address via GeckoTerminal
pool data (network `robinhood`) for the ticker, cross-checked its feed against the
canonical Chainlink feeds directory (`reference-data-directory.vercel.app/
feeds-robinhood-mainnet.json`), then verified BOTH independently on-chain before
writing anything down:
- Token: `symbol()` exact match, `decimals()` == 18, AND the EIP-1967 beacon
  storage slot matches `0xe10b6f6b275de231345c20d14ab812db62151b00` — the SAME
  beacon every known-good batch-1 token (SGOV/NVDA/SPY) proxies through. Every
  genuine Robinhood Stock Token is a beacon proxy against this one implementation;
  a token not on this beacon is not a real Robinhood Stock Token regardless of
  what `symbol()` claims.
- Feed: `description()` matches `Robinhood TICKER`/`RHTICKER` + `USD`,
  `decimals()` == 8, `latestRoundData()` returns a positive, recent answer.

**6 of 10 verified — added to `.env.example`, `setAssets.ts`, `SetAssets.s.sol`:**
AMD, COIN, PLTR, ORCL, MSTR, CRCL. Confirmed via a live dry-run: all 6 PASS
alongside the existing batch-1 10 (16/16 pass, 0 failures).

**4 of 10 NOT FOUND — left out, not padded:** AVGO, HOOD, NFLX, MCD have **no
entry at all** in the canonical Chainlink feeds directory (checked by exact
ticker match against all ~95 entries, not substring — a naive substring check
would have false-matched "HOOD" inside every "Robinhood" name in the file).
Per CLAUDE.md rule 17, no feed means no allowlisting is possible regardless of
whether a token contract exists. Real pools referencing these 4 tickers DO exist
on GeckoTerminal, but the search results for HOOD and MCD are cluttered with
obvious meme-coin lookalikes (HOODCATS, HOODRAT, HOODS, MCDon) — with no feed to
anchor identity against, picking one of those addresses would be exactly the
guess CLAUDE.md rule 14 forbids. `.env.example` documents this explicitly so it
isn't re-litigated on a future pass; re-check the feeds directory for these 4
before ever attempting to add them.

So a `--broadcast` run of `setAssets.ts` today would bring the allowlist to
**16**, not 20 — that's correct, not a shortfall to "fix" by guessing.

## Swap/trade-surface changes (useSwap.ts, SwapPanel.tsx, new useTokenQuotePools.ts)

`useSwap.ts` was hardcoded to WETH as the only tradable quote asset (stale
comment confirmed this predates 605eb27). Generalized to accept any quote asset:
- WETH: unchanged native-ETH wrap/unwrap path (the one already proven on mainnet
  via `ProveSwapMainnet.s.sol`).
- Any other GREEN asset (SGOV/NVDA/SPY): new `buildErc20SwapInput` in
  `web/lib/swap.ts` — Permit2-pull-in / TAKE_ALL-out on BOTH sides, no
  wrap/unwrap. This is the SAME action sequence (`SWAP_EXACT_IN_SINGLE`,
  `SETTLE_ALL`, `TAKE_ALL`) docs/robinhood-chain-research.md §4 recorded as
  proven by execution on mainnet (that proof's WETH input was itself pulled via
  Permit2, not wrapped) — only the ERC-20 on each side changes, not the shape.

**Explicitly NOT built**: true multi-hop routing (letting a WETH holder buy a
token whose only pool is quoted in NVDA, by routing WETH→NVDA→TOKEN through an
external market pool). That shape is verified-from-source in
`docs/robinhood-chain-research.md` §4 but never shipped or executed anywhere in
this codebase, and building it blind — with no way to test it from here — would
be exactly the "untested code in the most error-prone spot" this codebase's own
comments say to avoid. A user can still trade any live pool directly (holding the
matching quote asset); a WETH-only buyer on an NVDA-only-quoted token currently
has no route. Flagged as a gap, not silently worked around.

`useBacking.ts`'s existing WETH-only `hasPool`/`marketPriceWeth`/`marketPriceUsd`
fields were left completely untouched (still the source of truth for Discover/
backing-ratio math) — `useTokenQuotePools.ts` is a new, additive hook purely for
the trade surface, to avoid a large-blast-radius refactor of already-shipped,
tuned price/backing logic.

## Verification performed

- `npx tsc --noEmit` (web): clean, no errors.
- `npx tsx scripts/checkTickerLogos.ts`: clean (reads live AssetRegistry).
- `npx tsx scripts/setAssets.ts` (dry-run, live RPC): all 10 batch-1 PASS, all 10
  batch-2 SKIP as expected, no failures.
- `forge build` (contracts): clean, only pre-existing unrelated lint warnings.
- Live `cast call` reads against real mainnet: confirmed current factories lack
  the new multi-quote-asset function, confirmed registry has exactly 10 assets.
- Local anvil fork: factory deploy + single-GREEN-quote-asset `launch()` +
  direct `PoolManager.initialize()` all succeeded as real transactions. The full
  `graduate()`/swap/revert-on-bad-minOut proof is written
  (`ProveMultiQuoteSwap.s.sol`) but not yet run to completion — blocked by the
  free RPC's short state-retention window, not a known code defect.

## Blocked — needs a human with a paid/stable RPC + deploy keys

1. Run `ProveMultiQuoteSwap.s.sol` against a real fork (not the free public RPC)
   to finish proving the ERC20 quote-asset swap path end-to-end, including the
   impossible-`amountOutMinimum`-must-revert check.
2. Deploy the new `BallastFactory` (GREEN=[SGOV,NVDA,SPY]) via
   `DeployMainnet.s.sol` — or a dedicated factory-only redeploy script if the
   other five core contracts should stay as-is — then repoint
   `NEXT_PUBLIC_FACTORY_ADDRESS` / `NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES`.
3. Source + verify (via `cast call symbol()`/`description()`) the 10 batch-2
   token/feed address pairs, fill `.env.example`'s placeholders, then run
   `setAssets.ts --broadcast`.
4. Once a real project launches against a non-WETH GREEN quote asset, sanity
   check the new `SwapPanel` quote-asset picker and the ERC20 buy/sell path in
   the browser against real liquidity.
