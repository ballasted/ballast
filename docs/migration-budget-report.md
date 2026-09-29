# v1→v2 migration budget — the math, not the contract

The `BallastMigrator` contract, its Merkle root, and `/migrate` page are NOT
built yet (Section 5.1 backlog item — still open, see `docs/BALLAST_STATE.md`
for the estimate). This is the other half of that item: the real numbers
needed to set a migration budget, computed from data that already exists
(`data/snapshot/`) plus live chain/market reads today (2026-09-29).

## Snapshot total (from `data/snapshot/meta.json`, unchanged — captured 2026-09-26)

- Included holders: **71** (63 addresses excluded: pools, PoolManager,
  burn/dead, deployer, the Safe, and any other contract — see
  `data/snapshot/README.md` for the exact exclusion method).
- Included balance: **262,256,309.982629** v1 tokens.
- Price: **$0.000007100633157926953** per v1 token (the real 05:00–11:00 UTC
  TWAP; the window had zero trades, so this is the last real swap's price
  before it, block `72511886` — not a spot-price stand-in).
- **Total snapshot USD value: 262,256,309.982629 × $0.000007100633157926953
  ≈ $1,862.19.**

This is a small number — v1's remaining real (non-pool, non-team) holder base
is genuinely tiny. That smallness is exactly why pool depth matters more than
it would look like it should: even a few hundred dollars of buying is a lot
relative to how thin BALLAST v2's brand-new pools still are.

## What "cover X%" costs today, live (2026-09-29)

Live reads, not estimates from an old table:

- ETH/USD: **$2,713.73** (`0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9.latestRoundData()`, 8 decimals).
- BALLAST v2 / WETH pool reserve: **$2,834.48** (GeckoTerminal, pool
  `0xe33f257d541070d29d429cd29ec7fafaf9bafb666f0a54e62ad7eca782ed4ab1`).
- BALLAST v2 / NVDA pool reserve: **$2,842.34** (pool
  `0x868e436395e5f5a0fcd9f81a90904c8e04161cf0d8636548e4333cdad753697f`).

Price-impact estimate uses the SAME constant-product formula as
`docs/exit-liquidity-table.md` (`2 × tradeUSD / reserveUSD` — a triage
estimate, not a Quoter-simulated exact figure; real v4 concentrated liquidity
could differ from this in either direction):

| Coverage | USD to fund | ETH (at $2,713.73) | Impact on v2/WETH pool if bought there in one shot |
|---|---|---|---|
| 25% | $465.55 | 0.1716 ETH | **≈ 32.9%** |
| 50% | $931.09 | 0.3431 ETH | **≈ 65.7%** |
| 100% | $1,862.19 | 0.6863 ETH | **≈ 131.4% — exceeds the pool's one-sided depth; not executable as a single market buy at this price** |

## What this means for the budget decision

- **Even 25% coverage moves BALLAST v2's own price by roughly a third** if
  funded via a single market buy on its own (still-thin, freshly-graduated)
  pool. This is not a "small, safe" number — it's the single biggest lever
  on v2's price of anything that's happened since launch.
- **100% coverage is not executable as one trade** at today's depth — the
  pool doesn't have that much room in one direction; it would need to be
  split across time/tranches, split across BOTH v2 pools (WETH + NVDA), or
  funded a different way entirely (e.g. sending ETH/v2 tokens directly to
  the Migrator contract rather than buying through the AMM at all — the
  Migrator doesn't need to source tokens via a market swap; it could hold a
  pre-funded balance transferred in directly, sidestepping price impact
  altogether. This is worth deciding BEFORE the Migrator contract is built,
  since it changes what the contract needs to do.)
- **Depth will change between now and when this budget is actually spent** —
  these are today's numbers, re-check `reserve_usd` immediately before
  signing anything.

## What this report does NOT decide

- Whether "covering X%" means minting/transferring v2 tokens 1:1 with the
  snapshot USD value, sending ETH, or some other payout shape — that's a
  product decision the Migrator's design needs, not something this math
  implies on its own.
- The actual budget number — that's explicitly the human's call per the
  original brief ("I set the budget and sign the buy").
