# $BALLAST v1 snapshot — 2026-09-26

Captured per the migration-planning brief: balances of every $BALLAST v1
holder (`0x069a260370C61d91bd3e9842d81D378F9750F7F3`) at the first block
at/after 11:00:00 UTC on 2026-09-26. This is the raw balance snapshot only —
the Migrator contract, Merkle root, and migration-budget decision are Step 7
work, deferred; this data is what they'll be built on.

## Result

- **Snapshot block: `73030228`**, timestamp `2026-09-26T11:00:00.000Z` — this
  landed exactly on the target second (verified by binary search over real
  block timestamps from the live chain, not estimated).
- **`v1_snapshot.csv`** — `address,balance,usd_value,share`, one row per
  **included** holder, sorted by balance descending. 71 addresses.
- **`v1_snapshot_excluded.csv`** — every address holding a nonzero balance
  that was excluded, with the reason. 63 addresses.
- **`meta.json`** — machine-readable summary (block, totals, price source,
  CSV hash).
- **CSV keccak256**: `0x2df33a31d21cf14be476ec7306e26af8c0e1cdcb3129c3a0d8a62679c6106cc6`
- **TWAP 05:00–11:00 UTC**: `$0.000007100633157926953` per v1 token — real,
  not a spot-price stand-in (see the TWAP section below).

## Method

1. `snapshot_block.json` — binary-searched `eth_getBlockByNumber` against the
   live public RPC for the first block with `timestamp >= 1790420400`
   (2026-09-26 11:00:00 UTC). No estimation: every candidate block's real
   on-chain timestamp was read.
2. `fetch_transfers.cjs` — pulled every `Transfer` event ever emitted by the
   v1 token, from block 0 through the snapshot block, via `eth_getLogs`. The
   public RPC caps result count per call (`exceeds limit`) and independently
   times out on very wide ranges, so this adaptively splits any failing
   range in half and retries — no fixed chunk size assumed. 12,394 logs,
   37 RPC calls, ~65s. Raw logs are in `transfers_raw.json.gz` (gzipped,
   ungzip before reuse) as the audit trail behind the CSV.
3. `compute_balances.cjs` — replayed every transfer in `(blockNumber,
   logIndex)` order into a balance map. **Sanity-checked against the token's
   real on-chain `totalSupply()`: the reconstructed sum matches exactly**
   (`supply_check.json`, `match: true`) — if this hadn't matched, the
   snapshot would not have been trustworthy and none of the rest would have
   been built on it.
4. `classify.cjs` — for every nonzero holder, read `eth_getCode` to determine
   contract vs. EOA, and flagged the deployer / Safe / burn address
   explicitly. **Excluded, per the brief: pools, PoolManager, burn/dead,
   deployer, the Safe, contracts** — implemented as "any contract, full
   stop" (covers PoolManager and any pool/LP-adjacent contract automatically,
   without needing to enumerate pool addresses by hand) plus the three named
   EOA/Safe exceptions.
5. `build_csv.cjs` — computed `usd_value` and `share` for the 71 remaining
   (non-excluded) addresses and wrote the CSVs + `meta.json`.
6. `hash_csv.mjs` — real Keccak-256 (not NIST SHA3 — verified against the
   known test vector `keccak256("") =
   c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a47` before
   trusting it on the real file) via `viem`, since Node's built-in
   `crypto.createHash("sha3-256")` is a **different, incompatible** hash and
   would have silently produced a wrong "keccak256."

Re-run order: `fetch_transfers.cjs` → `compute_balances.cjs` → `classify.cjs`
→ `find_twap_range.cjs` → `fetch_swaps.cjs` (+ `find_last_swap.cjs` if that
comes back empty) → `build_csv.cjs` → `hash_csv.mjs` (the last one only
resolves `viem` if copied into `web/` or run with `--experimental-...`
resolution from there — see the script for the exact path it expects).

## The real 05:00–11:00 UTC TWAP

1. `poolId` for v1's WETH-quoted pool (`0x1cada39c16e1ca109c7f5d89fedebd8d11512d1c26c17e907766733112aec6f6`)
   computed from its `PoolKey` — `keccak256(abi.encode(currency0, currency1,
   fee=0, tickSpacing=60, hooks=0x9C15c992E4De3711715C8B7D717EF46e474680CC))`,
   `currency0`/`currency1` ordered by address value (v1 token < WETH).
   **Cross-checked against GeckoTerminal's own `top_pools` listing for v1,
   which names this exact pool ID** — independent confirmation the encoding
   is right, not just internally self-consistent.
2. `find_twap_range.cjs` — binary-searched blocks for 05:00 UTC (`72817110`)
   and a 2h-earlier anchor point, alongside the already-known 11:00 UTC
   block (`73030228`).
3. `fetch_swaps.cjs` — `eth_getLogs` on the `PoolManager`
   (`0x8366a39CC670B4001A1121B8F6A443A643e40951`) for `Swap` events
   (`Swap(bytes32 indexed id, address indexed sender, ...)`, confirmed from
   the vendored v4-core source, not guessed) matching this poolId, across
   the anchor-to-11:00 range. **Result: zero.** v1's pool did not trade at
   all in the window.
4. `find_last_swap.cjs` — widened the search backward (8h → 24h → 72h → …)
   until it found a swap. The most recent trade before the window is at
   block `72511886`, **2026-09-25T20:26:00Z** (Friday evening) — i.e. the
   pool has been silent for the ~14.5 hours leading into and through the
   entire TWAP window, not just the window itself.
5. **TWAP = that trade's price, exactly**, because a time-weighted average
   of a price that never changes across the whole window is that same
   constant — not an approximation or a fallback, the correct answer for
   this window's actual trading history. Price derived from that swap's
   `sqrtPriceX96` (`4072955300001116211666608`): `(sqrtPriceX96/2^96)^2` =
   WETH per v1 token = `2.6427745757708783e-9`, × ETH/USD (`$2686.81`, this
   session's live read, itself resting since Friday — see the earlier check)
   = **`$0.000007100633157926953`** per v1 token. Within ~2% of
   GeckoTerminal's independently-reported spot price
   (`$0.000007257632122`) — a real cross-check, not proof by itself, but
   consistent with a correctly-decoded price.

This doesn't change `share` in the CSV either way: with only one asset (v1)
valued at one price for every holder, share of USD value and share of token
balance are identical regardless of which correct price is used. The TWAP
only matters for sizing the total migration budget in USD terms (Part C3,
still deferred), not for any individual holder's proportional claim.

## Top holders (sanity spot-check, not for external use)

Largest included holder: `0x82ccddd324a6c14861cb622da051579d4e99ac54`,
32.3M tokens (12.3% of the included total). Excluded PoolManager
(`0x8366a39cc670b4001a1121b8f6a443a643e40951`) held 610.3M; burn/dead held
36.3M — consistent with the "36.3M+ burned" figure already cited elsewhere
for v1. 262.3M tokens (26.2% of total supply) are held across the 71
included real holders.
