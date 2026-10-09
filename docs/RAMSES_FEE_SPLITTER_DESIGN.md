# Ramses fee-splitter stack — design notes vs. Ramses' own launchpad guide

This fills in a doc that earlier code comments (`BallastFeeSplitter.sol`) already
referenced but that was never actually written in a prior session. It now also
serves as the step-by-step comparison against Ramses' own integration guide,
done 2026-10-09 at the user's request ("follow Ramses' own launchpad guide as
the source of truth").

Sources read in full: `ramses.xyz/docs/raw/for-launchpads.md`,
`ramses.xyz/docs/raw/concentrated-liquidity.md` (fee tiers, single-sided
liquidity / range orders), `tech.ramses.xyz/concepts/protocol/fees` (on-chain
fee mechanics — cross-checked against live reads, see below),
`ramses.xyz/docs/raw/contract-addresses.md`. Also opened and deemed not
applicable: `legacy-liquidity.md` and `dlmm.md` (we use Concentrated V3, not
Legacy V2 or DLMM), the DLMM integration tech guide, and the `v3-sdk` repo (a
TypeScript SDK; we integrate directly in Solidity).

## Guide-vs-implementation comparison

| Guide step | What the guide says | What we built | Match? |
|---|---|---|---|
| Choose the destination | Pick chain, token pair, pool model; confirm current contracts | Robinhood Chain, Concentrated V3, addresses verified on-chain (`positionManager.deployer() == PoolDeployer`, confirmed live) | **Match** |
| Add liquidity at launch/graduation | "Connect your flow to the appropriate Ramses router **or position manager**. Set the starting price, deposit amounts, and who receives and manages the LP position." | `RamsesLockLauncher.createAndLock()` mints directly via `INonfungiblePositionManager.mint()` (not a router), with caller-supplied amounts/range, recipient = the launcher itself, immediately re-pointed to the locker | **Match** (guide explicitly allows either router or position manager) |
| Verify the integration | Token compatibility, approvals, liquidity ownership, slippage protection | `amount0Min`/`amount1Min` slippage bounds; pulls by actual balance delta (fee-on-transfer safe); ownership ends at the locker, proven by test (`test_createAndLock_singleSided_locksToFreshSplitter`) | **Match** |
| Fee recipients | "Configure a compatible distributor to split collected LP fees between your chosen recipients" | `BallastFeeSplitter` + `BallastFeeSplitterFactory` | **Match** |
| Liquidity commitments | "A compatible V3 locker can keep launch liquidity locked while authorized recipients claim earned fees" | `RamsesLocker` (vendored, pinned commit) + `RamsesLockLauncher`; **not yet deployed anywhere** — Ramses is deploying a canonical instance within 12–24h of 2026-10-09, we will use that, not our own deploy (see `RAMSES_FEE_SPLITTER_DEPLOY.md`) | **Match once the canonical locker exists** |
| 80/20 fee split | "80% to creators, 20% to the platform, after the DEX protocol fee... Your launchpad configures the 80/20 split; Ramses does not pay it automatically" | Exactly what `BallastFeeSplitter` does — **this is Ramses' own example number**, not something we chose independently | **Exact match, nothing to change** |
| Single-sided liquidity / range orders | "You can approximate a limit order by providing a single asset as liquidity within a specific range" — range entirely above or below current price | `RamsesLockLauncher`'s `MintLegs` supports exactly this (one of `amount0Desired`/`amount1Desired` = 0, range on one side of current tick); matches `BallastSeeder`'s own one-sided-seed philosophy | **Match** |
| Fee tier selection | Table: 0.01%→stable pairs, 0.05%→"standard fee tier for most trading pools", 1%→"exotic pairs with significant volatility", up to 5% on Robinhood Chain | `RamsesLockLauncher` takes `tickSpacing` as a caller parameter — not hardcoded, so whoever launches picks the tier | **Match in spirit** (guide explicitly says "your launchpad controls its launch mechanics") — see recommendation below |
| Gauges | Gauged pools redirect 100% of swap fees to xRAM voters, 0% to LPs | We don't use gauges; our pools are plain fee-only/ungauged by default | **Not applicable — see risk below** |
| Scanner "locked" labels (GoPlus/GMGN/DexScreener) | Not covered anywhere in Ramses' docs (checked `tech.ramses.xyz`'s full doc index — no "locker"/"scanner" mentions at all) | Nothing to build — scanners recognize a locker by its *address* once it's well-known/canonical, which is exactly why we wait for Ramses' canonical deploy rather than using our own | **Not applicable / already the right plan** |

## Where we differ: nowhere that required a change

Every point of actual divergence turned out to be "the guide leaves this to the
integrator" (fee tier, initial price, lock/distribute mechanism shape), and on
the one point Ramses gives a concrete number — the 80/20 split — **it's their
own example**, identical to what's built. Nothing was changed as a result of
this comparison; this section exists because the task asked for the
comparison regardless of outcome.

## Recommendation (not hardcoded): fee tier for a real launch

Per the guide's own table, a freshly launched, previously-untraded token is
closer to "exotic pairs with significant volatility" (1% tier, tickSpacing
100) than "standard… most trading pools" (0.05%, tickSpacing 10). This is a
recommendation for whoever calls `createAndLock()`, not something baked into
the contract — `RamsesLockLauncher` takes `tickSpacing` as a parameter
specifically so this stays a launch-time choice. The fork test
(`ProtocolFeeSinkFork.t.sol`) uses tickSpacing 100 for exactly this reason —
confirmed on-chain and against this same guide table:
`RamsesV3Factory.tickSpacingInitialFee(100) == 10000` (1%).

## Risk, not previously flagged: gauging a locked pool kills its fee income

If Ramses governance (AccessHub) ever attaches a gauge to a pool holding one
of our locked positions, the fee-only default (95% LPs / 5% protocol) is
**replaced** by the gauged default (0% LPs / 100% to xRAM voters). Our locked
position would then collect **zero** swap fees going forward — not burned,
just redirected to voters, with the position's capital still locked and still
earning the gauge's own liquidity-mining emissions as compensation, but not
the trading-fee income the 80/20 split depends on. Nothing in the guide or the
fee-reference doc offers integrators any protection against this — it's
pool-level governance, outside launchpad control, same as the pool's
`feeProtocol` setting itself (see the per-pool 50% override already observed
on NVDA/USDG-WETH/AAPL — confirmed deliberate, not a bug, via
`RamsesV3Factory.poolFeeProtocol()`/`DEFAULT_FEE_FLAG` logic). This should be
disclosed to anyone using this mechanism for a real launch, and is why the UI
copy below says "governance sets the protocol fee" rather than promising a
fixed number.

## UI copy (for when a frontend surface for this exists — none does yet)

No `/app` UI references Ramses-locked launches at all yet — only contracts
have been built in this thread. When that surface is built (behind its own
feature flag, same pattern as `NEXT_PUBLIC_STOCK_BASKET_ENABLED` /
`NEXT_PUBLIC_GEN5_ENABLED`), use exactly this copy, factual and short, per the
user's instruction:

> Ramses governance sets the protocol fee on its pools (currently 5% of fees).
> The locked position receives the rest.

Do not name "the locker" by name anywhere in that UI until Ramses announces
their canonical deployment publicly (per the standing rule). "Ramses" itself
is already named elsewhere in shipped UI (`BallastRouterV2`'s swap-route
label), so naming the protocol is fine — only the locker's identity stays
unnamed for now.
