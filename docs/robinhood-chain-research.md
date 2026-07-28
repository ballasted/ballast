# Robinhood Chain — Technical Research

Compiled 22 July 2026 from official Robinhood Chain docs, Chainlink docs, Uniswap announcements, and the public Bags protocol docs (an existing launchpad on this chain).

**Verify every address against its primary source before deploying.** Addresses below are transcribed from public docs and can change.

---

## 1. Chain facts

| Fact | Value |
|---|---|
| Network | Robinhood Chain — Arbitrum Orbit L2, Ethereum blobs for DA |
| Mainnet chain ID | `4663` (`0x1237`) |
| Mainnet RPC | `https://rpc.mainnet.chain.robinhood.com` (rate-limited) |
| Testnet chain ID | `46630` — *note: some third-party lists say 46646; trust the official docs* |
| Testnet RPC | `https://rpc.testnet.chain.robinhood.com` |
| Faucet | `faucet.testnet.chain.robinhood.com` |
| Explorer | `robinhoodchain.blockscout.com` (Blockscout) |
| Gas token | ETH (18 decimals) |
| Block time | ~100 ms, first-come-first-served sequencer |
| Soft confirmations | ~100 ms target |
| Tooling | Fully EVM-compatible: Foundry, Hardhat, viem, wagmi, ethers all work unmodified |
| Account abstraction | First-class ERC-4337 support (gas sponsorship, batching, session keys) |
| Contact | `chain-developers-group@robinhood.com` |

### Consequences for how you write code

- **Use timestamps, not block numbers, for deadlines.** At ~100 ms blocks, block-number deadlines behave nothing like on Ethereum.
- **Priority fees buy nothing.** The sequencer is first-come-first-served; gas is negligible. Do not build fee-bidding logic.
- **The public RPC is rate-limited.** Batch reads with viem multicall (`Multicall3` at the canonical address). Plan for a paid provider (Alchemy is Robinhood's recommended one; QuickNode, dRPC and others also support the chain).
- **Verification:** `forge verify-contract --verifier blockscout --chain-id 4663`.

---

## 2. Stock Tokens — the asset class BALLAST is built on

~95 tokenized equities and ETFs at launch (NVDA, AAPL, GOOG, MSFT, AMZN and others), issued by Robinhood, priced by Chainlink.

**Mechanics:**

- Standard **ERC-20, 18 decimals**. `balanceOf`, `transfer`, `approve` all work normally.
- Also implement **ERC-8056 (Scaled UI Amount Extension)**.
- **They are NOT rebasing.** `balanceOf()` and `totalSupply()` never change from corporate actions.
- Corporate actions (dividends, splits) are handled by a **multiplier**: `uiMultiplier()`, 18-decimal fixed point, `1e18 = 1.0`. At launch every token is `1e18` (1 token = 1 share).
- `underlying shares = raw amount × uiMultiplier ÷ 1e18`
- Pending corporate actions are readable in advance: `newUIMultiplier()` and `effectiveAt()`.
- Events: `UIMultiplierUpdated(old, new, effectiveAtTimestamp)` and `TransferWithScaledUI(from, to, value, uiValue)`.
- UI helper views: `balanceOfUI(account)`, `totalSupplyUI()`.
- `oraclePaused()` — true while a corporate action is being processed.

**Important economic property for BALLAST:** because dividends are reinvested through the multiplier, a stock token tracks the **total return** of the underlying, not just the share price. A treasury holding NVDA tokens grows with reinvested dividends automatically, and the feed price will drift above the headline share price over time. This is expected, not a bug — and it is a genuinely attractive property for a project treasury.

**Trading:** stock tokens trade via **RFQ** at launch (e.g. 0x RFQ for NVDA ↔ USDG), alongside AMM liquidity supplied by Uniswap and Pleiades. They remain ordinary ERC-20s and can be held anywhere.

**Canonical token addresses**

| Token | Address |
|---|---|
| WETH (aeWETH proxy, WETH9-compatible) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

Stock token and ETF addresses are generated live from the on-chain asset registry at `docs.robinhood.com/chain/contracts`. Robinhood explicitly warns: a token with a matching name or ticker but a different contract address **is not** a Robinhood Stock Token. For BALLAST's allowlist, this is exactly the check that matters.

---

## 3. Chainlink price feeds — read this section twice

Source of truth for addresses, decimals and heartbeats:
`docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood`
Behavioural model: `docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood`

### Interface

Standard `AggregatorV3Interface` via the feed **proxy** address. `latestRoundData()` returns `(roundId, answer, startedAt, updatedAt, answeredInRound)`. Most USD feeds use **8 decimals**, but call `decimals()` — never hardcode.

### Observation: two `description()` naming formats coexist (verified 2026-07-28)

The canonical Chainlink directory (`reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`) labels every equity feed uniformly as `Robinhood TICKER / USD`, but the **on-chain `description()` is not uniform**. Reading it live on mainnet 4663, most feeds return `Robinhood TICKER / USD` (SGOV returns `Robinhood SGOV-USD`), while a subset returns an `RH`-prefixed form: `RHNVDA / USD`, `RHTSLA / USD`, `RHMSFT / USD`, `RHSPY / USD`. In every case the feed's `proxyAddress` still matches the directory exactly — the addresses are correct; only the on-chain description string differs.

This is an observation, not a problem. The takeaway for sourcing: **the address from the canonical directory is the identity guard, not the description string** — `description()` is publisher-controlled free text (any contract can return any string), so it only usefully catches a paste error, which "exact ticker + `USD`" verifies under either prefix. Our allowlist gate therefore accepts both forms; the exact string verified per asset at approval time is recorded in `web/scripts/setAssets.ts`. Do not gate on the literal word "Robinhood" alone — it would reject four legitimate feeds. (See CLAUDE.md rule 16.)

### The multiplier is already in the price

`latestRoundData()` returns the **full per-token price**, already including the corporate-action multiplier. **Do not apply `uiMultiplier()` to it yourself** — doing so double-counts and inflates your valuation. Only use the multiplier if you want to convert to share terms for display.

### ⚠️ Feeds are 24/5 and have NO heartbeat off-hours

Robinhood tokenized equity feeds run **24/5** — regular, pre-market, post-market and overnight sessions. So weekday nights *are* covered. The gap is **weekends, holidays, and thin overnight windows**.

During off-hours, per Chainlink: the feed **holds the last published price**, the contract stays callable, and **these feeds do not have heartbeats during off-hours**.

**This breaks the naive staleness pattern.** A contract containing:

```solidity
require(block.timestamp - updatedAt < heartbeat, "stale");   // ❌ WRONG HERE
```

will revert for the entire weekend, every weekend. Any valuation function built this way is bricked two days out of seven.

**Correct pattern for a read-only display product:** never revert on staleness. Return the age and let the caller decide.

```solidity
function priceOf(address asset) public view returns (uint256 price, uint256 updatedAt, bool stale) {
    (, int256 answer, , uint256 ts, ) = feed.latestRoundData();
    require(answer > 0, "invalid price");
    price = uint256(answer);
    updatedAt = ts;
    stale = (block.timestamp - ts) > staleAfter[asset];
}
```

Surface `stale` in the UI as "last updated {time}". Do not hide it, do not smooth it, and do not let the whole treasury view fail because one asset's feed is resting over a weekend.

### Corporate-action oracle pauses

While a corporate action is processing, the affected token's feed is **paused** to prevent publishing a price where the share price and multiplier are temporarily out of sync. Read `oraclePaused()` on the token.

Chainlink is explicit that **this flag is advisory and not enforced on-chain** — a paused oracle may still return a value. So keep your `updatedAt` staleness check as the primary guard and treat `oraclePaused() == true` as an additional "price temporarily unavailable" signal in the UI.

### Sequencer uptime — mandatory on L2

During a sequencer outage feeds go stale while contracts still respond. Check the Chainlink L2 Sequencer Uptime Feed before trusting any price:

```solidity
(, int256 sequencerStatus, uint256 startedAt, , ) = sequencerUptimeFeed.latestRoundData();
require(sequencerStatus == 0, "Sequencer down");                  // 0 = up
require(block.timestamp - startedAt > GRACE_PERIOD, "Grace period");
```

### Chainlink best-practice checklist

- Check staleness via `updatedAt` with bounds appropriate to the asset (equities ≠ crypto)
- Reject zero or negative answers
- Read `decimals()`, never hardcode
- Check sequencer uptime
- Read `oraclePaused()` as a secondary signal
- Handle `uiMultiplier()` consistently, and never apply it to the feed price

---

## 4. Uniswap on Robinhood Chain

**v2, v3, v4 and UniswapX all deployed from day one** (chain mainnet launched 1 July 2026). Uniswap is the chain's primary public AMM, supported in the Uniswap Web App, Wallet and API.

Early traction was large: over $250M volume in week one per Uniswap's own account, $563.9M on 8 July, and reported cumulative figures ranging from $1B (Uniswap governance forum) to $6B (independent reporting) by 10 July. Treat the higher figures cautiously — methodologies differ.

Notably, the chain was built for RWAs but **its first breakout was memecoin activity**. That tension is exactly the gap BALLAST is positioned in.

### ⚠️ The UniversalRouter on this chain is a modified fork

Per the Bags protocol docs, the UniversalRouter deployed on Robinhood Chain is a **modified fork**: its v4 swap struct carries an extra `minHopPriceX36` field, so **calldata built with the stock Uniswap SDK will revert**. The docs also warn that **two other router look-alikes exist on this chain**, and only one address is correct.

This is the single most expensive gotcha in this document. Budget time to get the encoding right, and verify the router address independently before sending value through it.

#### ✅ RESOLVED 2026-07-23 — verified encoding

Router **`0x8876789976dEcBfCbBbe364623C63652db8C0904`**, confirmed on Blockscout as a verified fork of Uniswap `universal-router` + `v4-periphery` (source contains the `minHopPriceX36` modification). Two look-alikes exist; only this address carries the matching verified fork source. Re-verify before sending value.

Entrypoint: `execute(bytes commands, bytes[] inputs, uint256 deadline)` — **timestamp** deadline. A v4 swap is command byte `0x10` (`V4_SWAP`); its input is `abi.encode(bytes actions, bytes[] params)` with actions `[0x06 SWAP_EXACT_IN_SINGLE, 0x0c SETTLE_ALL, 0x0f TAKE_ALL]` (single-hop) or `0x07 SWAP_EXACT_IN` for multi-hop.

**The `minHopPriceX36` fork field has TWO shapes** (the trap — one field, two types):

- **Single-hop `ExactInputSingleParams`** (what BALLAST needs for a graduated token/WETH pool): `{ poolKey, zeroForOne, amountIn (uint128), amountOutMinimum (uint128), minHopPriceX36 (uint256), hookData }`. The fork inserts `minHopPriceX36` **after `amountOutMinimum`, before `hookData`**. Enabled iff `!= 0`; set **0 to disable** and rely on `amountOutMinimum`.
- **Multi-hop `ExactInputParams`** — ⚠️ **exists and is verified from source, but BALLAST does NOT ship it** (single-hop only: graduated pools are token/WETH, native ETH uses WRAP/UNWRAP, the treasury never swaps). Recorded here in case it is ever needed. Verified field order from the deployed `IV4Router.sol`: `{ currencyIn, path (PathKey[]), minHopPriceX36 (uint256[]), amountIn (uint128), amountOutMinimum (uint128) }` — `minHopPriceX36` is the **THIRD field, after `path`, before `amountIn`**, NOT trailing; length **0 (disabled)** or **exactly `path.length`**, else the router reverts `InvalidHopPriceLength`. Not carried in `IRobinhoodV4Router.sol` / `robinhoodRouter.ts`.

`X36` = fixed-point ×10^36 (minimum execution price per hop). Stock Uniswap SDKs omit the field entirely → their calldata reverts here; **manual encoding is mandatory.** Canonical references: `contracts/src/interfaces/IRobinhoodV4Router.sol` (Solidity structs + command/action constants) and `web/lib/robinhoodRouter.ts` (viem ABI params).

#### ✅ PROVEN BY EXECUTION 2026-07-23 (not just source)

`contracts/script/ProveSwapMainnet.s.sol` ran the full four-step proof on mainnet against a real WETH/token pool (liquidity confirmed via StateView): (1) StateView liquidity, (2) V4Quoter quote, (3) `forge script` simulate `execute()`, (4) real broadcast. All three of quote / simulation / on-chain result returned the **identical** output (`75649940621173298741106` token units for `0.00001` WETH), so `ExactInputSingleParams` with `minHopPriceX36 = 0` and actions `[0x06,0x0c,0x0f]` is decoded correctly by the fork router. Swap tx `0xddf8b24a81a2e01383018f7889eef12b868a484509f8f8f0209cb3a13235ee5a`. Input settled via Permit2 (WETH → Permit2 → router); output taken to the caller. The v4 singletons (PoolManager/PositionManager/V4Quoter/StateView) and permissionless hooks (standard flag-bit mining, no allowlist) are also verified.

---

## 5. Reference architecture — how an existing launchpad does it here

Bags is a live launchpad on Robinhood Chain with fully public, permissionless contracts and no API key required. It is the closest available blueprint. Addresses from their docs:

| Contract | Address | Role |
|---|---|---|
| `BagsFactory` | `0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37` | Launch entry point + registry (UUPS proxy) |
| `BagsLens` | `0xC82Db941dAf90B754aecb5F7D14c683dc608d595` | Batched read aggregator |
| `BagsV4Hook` | `0x2380aBf72C17aABAb76480244759AC7E2932EEcC` | Singleton v4 hook, takes post-migration fee |
| `BagsVault` | `0x4861446aa7fFd9e67a83cBbAcb1A4B70540B83Aa` | Platform treasury (UUPS proxy) |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | **Modified fork** |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` | Off-chain quotes |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | Pool state reads |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Uniswap v4 singleton |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | v4 periphery (LP mint on migration) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Canonical |

Protocol deploy block `7887312` — a useful lower bound for log scans.

### Their token lifecycle

1. **Create** — factory deploys per-token token + bonding curve + fee-share contract, mints fixed supply to the curve, registers it.
2. **Bonding curve** — virtual `x·y=k`, buys send native ETH, sells return ETH. 830M of a 1B supply sells on the curve.
3. **Graduation** — when real ETH reserves hit `thresholdQuote`, the next buy triggers migration: remaining 170M plus the full raise go into a Uniswap v4 pool with their hook, at the curve's final price. **LP is locked permanently.** Curve pauses, emits `Migrated`.
4. **Post-graduation** — trades route through the modified UniversalRouter against the token/WETH pool.

### Their fee model

Flat **2% on the ETH/WETH leg of every trade, in both phases**, split 1% creator / 1% protocol. On buys the fee comes off the ETH input; on sells, off the ETH output. Protocol half splits between an optional partner (default 25% of that half) and the platform vault. One-time creation fee, default **0.02 ETH**.

### Patterns worth copying

- **Per-launch contracts as proxies** — EIP-1167 minimal clones for the token, beacon proxies for the curve and fee-share. Cheap deploys, upgradeable logic where it should be.
- **A Lens contract** — one batched read call powering the UI instead of dozens of RPC round-trips. On a rate-limited public RPC this matters a lot.
- **Never hardcode per-launch addresses.** Resolve from the creation event or the factory registry.
- **Read economic globals live** (`creationFee`, `graduationThreshold`, `partnerFeeBps`), because they are owner-settable and snapshotted per launch.
- **An explicit `migrated` flag** to route trades to the right venue. Never infer the phase.

---

## 6. Corrections this research forces on the BALLAST spec

| # | Previous assumption | Correct position |
|---|---|---|
| 1 | Revert on stale price (`require(... < heartbeat)`) | **Never revert.** Feeds have no heartbeat off-hours; a reverting valuation is bricked every weekend. Return a staleness flag instead. |
| 2 | "Equity oracles are stale more than half the time" | Overstated. Feeds are **24/5** and cover weekday overnight. The real gaps are **weekends, holidays, thin overnight windows**. |
| 3 | Backing formula needs no caveat | Add explicit warning: the feed price **already includes** `uiMultiplier()`. Applying it again double-counts. |
| 4 | Uniswap version unconfirmed | **v2, v3, v4 and UniswapX are all live.** Use v4 with a custom hook for fee capture. |
| 5 | Standard Uniswap SDK assumed | **The UniversalRouter is a modified fork** with an extra `minHopPriceX36` field. Stock SDK calldata reverts. Look-alike routers exist. |
| 6 | Sequencer uptime not mentioned | **Mandatory L2 check** before trusting any price. |
| 7 | Corporate actions not handled | Stock tokens are **ERC-8056**. Track `UIMultiplierUpdated`, read `oraclePaused()`, respect pending `newUIMultiplier()` / `effectiveAt()`. |
| 8 | Generic "allowlist Chainlink-priced assets" | Allowlist must check the **canonical registry address**, since same-ticker impostor tokens are an explicitly documented risk. |
| 9 | Block-number deadlines | **Use timestamps.** ~100 ms blocks. |
| 10 | Direct RPC reads | **Batch with multicall** and add a Lens-style aggregator; the public RPC is rate-limited. |

---

## 7. Open questions still requiring verification

- Exact Chainlink feed proxy addresses, decimals and per-asset staleness bounds — read from the Chainlink Robinhood feeds page at build time.
- L2 Sequencer Uptime Feed address on this chain.
- The exact v4 swap struct encoding for the modified UniversalRouter, and independent confirmation of the correct router address.
- Whether Uniswap v4 hook deployment is permissionless here (address-mining for hook flags behaves as on other chains, but confirm).
- Whether stock tokens carry any transfer restrictions or allowlists that would affect a treasury contract holding them — **critical for BALLAST**, and not answered in the public docs reviewed here.
- Jurisdictional eligibility: stock tokens are described as available "in eligible regions", which has direct implications for who can ballast a launch.

---

## Primary sources

- `docs.robinhood.com/chain` — chain overview, connecting, contracts, protocol contracts, gas, finality
- `docs.robinhood.com/chain/building-with-stock-tokens` — ERC-8056, multiplier, valuation examples
- `docs.robinhood.com/chain/oracles-and-price-feeds` — feeds, staleness, sequencer, oracle pauses
- `docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood` — 24/5 behaviour, off-hours model
- `blog.uniswap.org/robinhood-chain-is-live` — v2/v3/v4/UniswapX deployment
- `docs.bags.fm/robinhood/overview` — working launchpad architecture and address book
