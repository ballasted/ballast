# BALLAST — Full Technical Report

*Compiled 2026-10-25. On-chain figures read at 2026-10-24 20:04 UTC, Robinhood Chain (chainId 4663), block 97,026,046, via the public RPC `https://rpc.mainnet.chain.robinhood.com` and Blockscout. Every feature is labelled **LIVE** (deployed and visible in production), **BUILT BUT OFF** (code complete, behind a flag), **IN PROGRESS**, or **PLANNED**. Where a value could not be read in this pass it is marked "not read".*

Domain: **ballasted.fun** — marketing at root, the app under `/app`.

---

## 1. Summary

Ballast is a token launchpad on Robinhood Chain where a project can hold a verifiable on-chain treasury of tokenized real-world assets (Chainlink-priced stock tokens like SGOV, NVDA, SPY), and the value of that treasury is shown live on the token's page as **backing per token**. Every launch opens at a fixed valuation with 100% of supply seeded into a locked Uniswap v4 pool — no team allocation, no presale. Holding a token gives no claim, redemption right, or entitlement to the treasury assets; the backing is a transparency figure, not a redemption promise. On top of the launch primitive, Ballast adds per-token fee routing, a $BALLAST buyback that sends tokens to the dead address, community burn-to-vote, stock round-ups, stock baskets, a non-custodial Telegram launch Mini App, and a public analytics surface.

---

## 2. Live features

### 2.1 The launch — **LIVE**
- **What a user does:** on `/app/create`, picks a name/ticker, up to two pool pairings (WETH and/or a listed stock token), optionally funds a treasury, sets an immutable withdrawal notice period, and signs one launch. 100% of supply is seeded to the pool(s); the LP position is permanently locked. Each pairing gets its own Uniswap v4 pool, each opening at a fixed 1 ETH-equivalent valuation regardless of treasury size.
- **How it works:** `BallastFactory.launch()` mints the fixed supply, creates the v4 pool(s) via the singleton PoolManager with the Ballast hook baked into the PoolKey, and seeds liquidity through `BallastSeeder`. Pool identity is deterministic (token/quoteAsset/hook, tickSpacing 60, fee 0 — the hook takes the fee).
- **Contracts (gen-4, current):** BallastFactory `0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67`, BallastHook `0x4eb2dd759f4d6524e66057d1adc10c26e40142cc`, BallastSeeder `0x690241daf35efdf34e0b726aceb451bd901858db`.
- **Safety:** no team/presale allocation (100% to pool); liquidity permanently locked; the withdrawal notice period is immutable after deploy. Opening valuation is fixed and the same whether a treasury is empty or full. Fees can be zero.
- **URL:** `/app/create`, token page `/app/token/[address]`.
- **Why it's different:** the launch itself proves there's no insider supply — everything is in the locked pool from block one.

### 2.2 The hook and fee flow — **LIVE**
- Swaps route through a modified UniversalRouter `0x8876789976dEcBfCbBbe364623C63652db8C0904` into the Ballast hook, which takes the swap fee on the quote leg.
- **Current swap fee, read live from FeeConfig `0xE09F093595045E8765F420Cb12E0AA250910E5AD`:** `feeParams = 300 / 8000 / 2000 / 0` → **3% per swap**, split **80% creator / 20% platform / 0% referrer**. The platform's 20% vault is the $BALLAST buyback burner (auto-funded). The app reads these live, never hardcoded. Fees can be zero.
- **URL:** shown on every token page ("Swap fee" card).

### 2.3 Per-token FeeRouter — **LIVE**
- A creator can route their fee share into buckets (e.g. treasury / buyback / staking) via a per-token FeeRouter. Routing is permissionless to execute; changing the split uses an **asymmetric 7-day delay** — lowering the creator's own share is instant, raising it waits out the delay.
- FeeRouterFactory v1 and v2 are both configured in production (v2 adds an initial split active from block one plus the asymmetric delay). New launches route through v2.
- **URL:** the fee-router card on the token page; set up in the Create flow's Fees section.

### 2.4 Token families (parent burn) — **LIVE** (via FeeRouter v2)
- A launch can name a parent token and route a portion of fees to burn the parent (sent to the dead address). Burns can be zero.

### 2.5 Project treasury and backing — **LIVE**
- **What it does:** a creator deposits allow-listed, Chainlink-priced stock tokens into the launch's `ProjectTreasury`; the token page shows live total and locked backing and backing-per-token, read through `BackingLens`. A public directory lists every treasury.
- **How it works:** assets are allow-listed by canonical contract address in `AssetRegistry`; valuation reads the asset's Chainlink Standard-proxy feed (never the SVR proxy), reads `decimals()` from the feed, and never reverts on a stale price (it returns a stale/resting flag instead, since tokenized-equity feeds have no weekend heartbeat). The sequencer-uptime check is optional — chain 4663 publishes no sequencer feed, so the UI states "sequencer status unverifiable" rather than implying a check.
- **Contracts:** AssetRegistry `0x427764d0d19aB765c35A41A5aa4771580307dA81`, BackingLens `0x73Ac3574c8743553f41C6E25F92A145b5c0e7240`.
- **Safety:** creators can withdraw **only** what they deposited, and only after the immutable notice period, with each withdrawal announced on-chain first; third-party deposits are permanently locked; `asset != projectToken` (self-backing impossible). Holding a token gives no claim, redemption right, or entitlement to these assets.
- **URL:** `/app/backing`, `/app/backing/[address]`.
- **Why it's different:** the backing number is read from the same on-chain feeds anyone can verify, and the no-claim line is shown right next to it.

### 2.6 Open Treasury — **LIVE**
- Permissionless community deposits into a shared treasury vault earning a variable share of trading fees. Factory `0xF2B171DF729fd6701553610732eB43d13417e1d9`, Lens `0x5827211D43599bA88882EbB6bC1791813F4C5C10`; flag `NEXT_PUBLIC_OPEN_TREASURY_ENABLED=true` in production. The fee share can be zero.

### 2.7 Stock baskets (BasketZap) — **LIVE (read); create path limited**
- Swap ETH into up to 6 listed stock tokens in one transaction, forwarded to the creator's own wallet to deposit themselves (BasketZap can never call `ProjectTreasury.deposit` on a creator's behalf). BasketZap `0x87c046aB0fB8B7B86BA1a62A956242d499051aBA`. The basket directory/read surfaces are live; the create path requires an on-chain WETH route for an AssetRegistry asset, which is limited today — the picker shows an honest "not routable yet" where none exists.
- **URL:** `/app/baskets`.

### 2.8 Ramses locked pools + ProtocolFeeSink — **LIVE**
- An alternative launch venue: the token's pool lives on Ramses' concentrated-liquidity venue with its LP permanently locked, fees split via a BallastFeeSplitter into a ProtocolFeeSink. Launcher `0x88BC1d1FBb09807C067dF5c68177126f59cdA284`, locker `0xF6CD2e03259150D4FF745CDd620c09FBF30DE1dC`, Ramses v3 factory `0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8`, position manager `0x2eBd7B85a4E08D5B508b04BA147976C94afE6590`; flag `NEXT_PUBLIC_RAMSES_ENABLED=true`.

### 2.9 $BALLAST buyback and burn — **LIVE**
- **What it does:** the platform's 20% fee share funds a buyback of $BALLAST; bought tokens are sent to the dead address `0x…dEaD` (burned, irrecoverable). Anyone can trigger it once the accrued balance clears the threshold. Burns can be zero.
- **Contracts:** BuybackBurner v1 `0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be` (immutable target = v1 token); **BuybackBurnerV2 `0xDA9ef87A6146f435d34237a9B3a81689603Fa503`** (= the gen-4 FeeConfig `platformVault`, auto-funded, ownerless; per-call WETH/NVDA caps enforced on-chain).
- **Live numbers (read 2026-10-24 20:22 UTC):** BuybackBurnerV2 has run **84 buybacks**, burning **18,682,912 $BALLAST**, spending **0.1604 WETH + 1.834 NVDA**; pending `accruedWeth` ≈ 0.0001. Across *all* burn mechanisms (buyback v2 + v1 + burn-to-vote), **$BALLAST at the dead address = 34,391,620 tokens = 3.439% of the 1,000,000,000 supply** (read 20:04 UTC) — so ~18.68M of that is buyback-v2 and ~15.7M is from other burns.
- **URL:** `/app/buyback`.

### 2.10 Burn-to-vote — **LIVE**
- Burn a token to vote for its community-default round-up stock. Votes send tokens to the dead address (irrecoverable) and control no funds. BurnVote `0xfC47B36d239dA6174d714284634440C24bE66652`.
- **URL:** `/app/vote` and a compact card on each token page.

### 2.11 Team split — **LIVE**
- An immutable payout target a creator points their fee share to, splitting it across a team. CreatorSplitterFactory `0x0A929356Ca3F9D5f675B495BdFDfAbFC300fa9cf`.
- **URL:** `/app/team-split`.

### 2.12 Stock round-ups — **LIVE (no usage yet)**
- On a buy, optionally round up and spend a little extra ETH on a stock token delivered to the trader's **own** wallet (Ballast takes nothing; no claim on any treasury). Batched with the main buy via EIP-5792, with a two-transaction fallback. RoundupRouter `0x3EE06Fb833dDcB0dF9eC05415c1b95EE2285ec12`, RoundupMainAdapter `0xC4AF518E4dB5Cf07f0e841a88976F76d63FCb3B9`, BasketStockBuyer `0xfD23f74950751e400bb593036492EF59EA944167`.
- **Live number:** **0 real round-up transactions so far** (BasketStockBuyer `StockBought` events = 0 over the last 3M blocks, read 2026-10-24).
- **URL:** the round-up toggle in the swap panel.

### 2.13 Launch from Telegram + alert bot — **LIVE**
- A non-custodial Telegram Mini App at `/app/tg-launch` lets a user launch a token signing with their own wallet (WalletConnect/Reown) from inside Telegram; it uses Telegram's native MainButton/BackButton, respects safe areas, and suppresses in-app toasts over the form. The separate Telegram alert bot posts launch/trade/burn activity (`TG_BOT_ENABLED`; note `TG_DRY_RUN` controls whether it posts for real — verify the current value).
- **Flag:** `NEXT_PUBLIC_TG_MINIAPP=true` in production.

### 2.14 Analytics + indexer — **Analytics LIVE; indexer LIVE for launches, IN PROGRESS for trades/volume**
- `/app/analytics` shows volume, trades, launches, $BALLAST sent to the dead address, stock backing, and the pairing mix.
- A read-only Postgres (Neon) indexer is deployed with migrate/backfill routes and a 2-minute cron. It currently indexes launches reliably. On-chain v4 Swap-log coverage is only partial on this chain's RPC (result caps on the singleton PoolManager), so **user-facing trades/volume/price still read from GeckoTerminal, and holders from Blockscout** — the accurate, complete sources — until the indexer's per-pool swap coverage is validated to match. (A per-pool, topic-filtered, small-chunk swap indexer is now deployed and being validated.)

### 2.15 SDK + developer docs — **BUILT (preview)**
- `packages/sdk` — npm name `ballast-sdk`, version `0.1.0-preview`. Exports `createBallast()` client plus `reads`, `quotes`, `writes`, `events`, `pool`, `validate`, `constants`, `errors`. Whether it is published to the public npm registry was not verified in this pass. Developer docs live under `docs/` and the in-app `/docs` routes.

### 2.16 Manatee NFT — **LIVE**
- A standalone 1,000-piece fully on-chain ERC-721 (`/app/mint`), separate from the protocol. BallastManatee `0xfd3534f2a6ca756e95e5d2ff7bd287954b856e4b`, renderer `0xbd602bddb55b3a200015bafcd975e54a93549327`.

### 2.17 AI helper (Raeto) — **LIVE** · Share cards — **BUILT BUT OFF**
- The AI create/summary helper is enabled in production (`NEXT_PUBLIC_AI_HELPER_ENABLED`, `RAETO_API_KEY`), with guardrails against investment framing. Share-on-X cards are built but the flag is off.

---

## 3. Live numbers (read 2026-10-24 20:04 UTC, block 97,026,046)

| Metric | Value |
|---|---|
| $BALLAST total supply | 1,000,000,000 |
| $BALLAST at the dead address (all burns) | 34,391,620.47 (**3.439%** of supply) |
| — of which BuybackBurnerV2 | 18,682,912 over **84 buybacks** |
| Buyback v2 spend | 0.1604 WETH + 1.834 NVDA |
| Launches (non-hidden, all generations) | 18 (indexer `launchesTotal`) |
| Treasuries funded with real backing value | ~0 today (Analytics "Stock backing" ≈ $0.00 across treasuries) |
| Open Treasury deposits | not read this pass |
| Round-up transactions | 0 |
| $BALLAST holders | not read — Blockscout unreachable at report time (retry later) |

*Note: "backing ≈ $0" means no treasury currently holds meaningful allow-listed stock value, not that treasuries don't exist.*

---

## 4. Contract registry (chain 4663)

| Contract | Address | Gen | Owner | Verified |
|---|---|---|---|---|
| BallastFactory | `0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67` | 4 (current) | none (no admin surface) | Sourcify |
| BallastHook | `0x4eb2dd759f4d6524e66057d1adc10c26e40142cc` | 4 | none | Sourcify |
| BallastSeeder | `0x690241daf35efdf34e0b726aceb451bd901858db` | 4 | none | Sourcify |
| BallastRouterV2 | `0xa0Aba92d3D99eC905BcFc8a6aCfC889468a747E0` | — | none (routes fixed at construction) | Sourcify |
| FeeConfig (gen-4) | `0xE09F093595045E8765F420Cb12E0AA250910E5AD` | 4 | Safe (pending-accept noted in state doc) | not read |
| AssetRegistry | `0x427764d0d19aB765c35A41A5aa4771580307dA81` | shared | EOA `0xA277…837D1` | not read |
| BackingLens | `0x73Ac3574c8743553f41C6E25F92A145b5c0e7240` | shared | none | Sourcify |
| BallastFactory (gen-1) | `0x069974136c78Cf0F2162463B95321E59F56523D8` | 1 | none | — |
| BallastHook (gen-1) | `0x9C15c992E4De3711715C8B7D717EF46e474680CC` | 1 | none | — |
| BallastFactory (gen-2) | `0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1` | 2 | none | — |
| BallastHook (gen-2) | `0x743102aa1De955b5F0Fada1377B6E545Fdb080cc` | 2 | none | — |
| BallastFactory (gen-3) | `0x3eb5532e982931cad40d0416adbd7930a57965ae` | 3 | none | — |
| BallastHook (gen-3) | `0x4915f612c89100bEbE9279355fab27022D0940cc` | 3 | none | — |
| BuybackBurner v1 | `0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be` | — | EOA `0xA277…837D1` | not read |
| BuybackBurnerV2 | `0xDA9ef87A6146f435d34237a9B3a81689603Fa503` | — | ownerless (auto-funded; = gen-4 FeeConfig platformVault) | not read |
| RoundupRouter | `0x3EE06Fb833dDcB0dF9eC05415c1b95EE2285ec12` | — | none | verified (state doc) |
| RoundupMainAdapter | `0xC4AF518E4dB5Cf07f0e841a88976F76d63FCb3B9` | — | none | verified |
| BasketStockBuyer | `0xfD23f74950751e400bb593036492EF59EA944167` | — | none | verified |
| BurnVote | `0xfC47B36d239dA6174d714284634440C24bE66652` | — | none | verified |
| CreatorSplitterFactory | `0x0A929356Ca3F9D5f675B495BdFDfAbFC300fa9cf` | — | none (stateless) | verified |
| BasketZap | `0x87c046aB0fB8B7B86BA1a62A956242d499051aBA` | — | none | Sourcify |
| OpenTreasuryVaultFactory | `0xF2B171DF729fd6701553610732eB43d13417e1d9` | — | not read | not read |
| OpenTreasuryLens | `0x5827211D43599bA88882EbB6bC1791813F4C5C10` | — | none | not read |
| Ramses launcher | `0x88BC1d1FBb09807C067dF5c68177126f59cdA284` | — | not read | not read |
| Ramses locker | `0xF6CD2e03259150D4FF745CDd620c09FBF30DE1dC` | — | Ramses' own canonical contract | — |
| FeeRouterFactory v1 / v2 | set in prod env | — | stateless | state doc |
| BallastManatee / renderer | `0xfd3534f2a6ca756e95e5d2ff7bd287954b856e4b` / `0xbd602bddb55b3a200015bafcd975e54a93549327` | — | EOA / none | — |
| $BALLAST v1 (retired) | `0x069a260370c61d91bd3e9842d81d378f9750f7f3` | — | — | — |
| $BALLAST v2 | `0xDc605041F02e41CbD8FDC347023e93C4c3fA243C` | — | — | — |

**External (not Ballast):** PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, UniversalRouter (modified fork) `0x8876789976dEcBfCbBbe364623C63652db8C0904`, WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, ETH/USD feed `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`.

*Owner/verified columns marked "not read" were not re-queried on-chain in this pass; `docs/BALLAST_STATE.md` is the maintained source of record and should be cross-checked before publishing exact ownership/verification claims.*

---

## 5. Control and trust model

- **Protocol Safe:** `0xEFC97e16a24d2434C7138a2634E554a0631aC079` — confirmed on-chain as the **owner of the gen-4 FeeConfig** (`owner()` read 2026-10-24). Its signer threshold was not read on-chain in this pass — confirm before publishing.
- **FeeConfig `0xE09F…E5AD`:** owned by the Safe; can change the swap fee and split (current 3% and 80/20/0, read live). The on-chain maximum-fee cap was **not read this pass** — verify directly before making any "max fee" claim. There is no timelock contract deployed (the DeployTimelock script exists but is unused per the state doc), so FeeConfig changes are not time-delayed.
- **AssetRegistry:** owner is the original EOA `0xA2774e53dCb666799dBA7d00dC11d10d7Ff837D1` (allow-list control). Moving it to the Safe is a known open item.
- **Immutable by design:** `ProjectTreasury.noticePeriod`; a pool's hook (fixed in the PoolKey at graduation); creators can withdraw only their own deposits; `asset != projectToken`.
- **Ownerless (no admin surface):** BallastFactory, BallastHook, BallastSeeder, BallastRouterV2, BackingLens, BasketStockBuyer, RoundupRouter/Adapter, BurnVote, CreatorSplitterFactory, BuybackBurnerV2.
- **Audit:** the contracts are **not externally audited**. Verification is via Sourcify/Blockscout where noted.

---

## 6. Infrastructure

- **Hosting:** Vercel (`ballastedapp/ballast`). Production + Preview env sets carry all contract addresses, flags, and the Neon DB connection; two stale vars (`NEXT_PUBLIC_ROUTER_ADDRESS`, `NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES`) were removed this pass. Automation-bypass for protected previews is a dashboard toggle (not set via CLI here).
- **Crons:** the Telegram alert poller and `/api/cron/index` (indexer incremental, every 2 min).
- **Database:** Neon Postgres (pooled `DATABASE_URL` for reads, unpooled for migrations). Migrated + backfilled.
- **Data sources:** GeckoTerminal (price, trades, volume, OHLC), Blockscout (holders, explorer), the public Robinhood RPC + a dedicated keyed RPC behind `/api/rpc`, Chainlink feeds (backing valuation), Upstash KV (rate limits / bot state).
- **RPC note:** `eth_getLogs` is result-capped on this chain — the reason on-chain swap indexing is sourced carefully and trades/volume currently come from GeckoTerminal.

---

## 7. Built but off / in progress / planned

- **Indexer-powered trades/volume — IN PROGRESS.** Backend + per-pool swap indexer deployed; blocked on validating coverage matches GeckoTerminal within tolerance before switching user-facing numbers.
- **gen-5 limit-order hook — BUILT BUT OFF.** On branch `feat/gen5-limit-orders`; audit-gated and not deployed.
- **Share-on-X cards — BUILT BUT OFF.** Flag off in production.
- **Multichain launchpad, Aerodrome-style routing, index tokens — PLANNED.** No code in production.
- **Timelock on protocol controls — PLANNED.** Script exists, not deployed.

---

## 8. Known issues and limits

- On-chain swap-log indexing is partial on this RPC (result caps); trades/volume therefore rely on GeckoTerminal, which can briefly lag or be unavailable (the UI shows "unavailable", never a fake zero).
- Stock baskets' create path is limited until an AssetRegistry asset has an on-chain WETH route.
- Tokenized-equity Chainlink feeds have no weekend/holiday heartbeat; backing shows a "resting" vs "stale" state rather than reverting.
- No sequencer-uptime feed exists on chain 4663; the UI states sequencer status is unverifiable.
- Contracts are not externally audited.
- The Telegram Mini App wallet-connect round-trip depends on the wallet's universal-link return behavior (verified working on iPhone by the operator).

---

## 9. Changelog — last 7 days (2026-10-18 → 2026-10-25)

- **2026-10-24:** Deployed Phase-3 contracts (BasketStockBuyer, RoundupMainAdapter, RoundupRouter, BurnVote, CreatorSplitterFactory); set the gen-4 swap fee to 3% (300/8000/2000/0).
- **2026-10-24:** Merged + deployed the stock round-up execution path (EIP-5792 batch); round-up/burn-vote/team-split/TG-Mini-App env flags turned on in Production.
- **2026-10-24/25:** Merged + deployed the big cleanup: slim left icon-rail navigation (desktop top bar removed), design-system primitives + Analytics page, empty-state fixes (no fake zeros), compact burn-to-vote, Telegram Mini App fixes, the Neon indexer backend, holders distribution bar, and a design-system sweep across backing/baskets/treasury/vote. Removed two stale Vercel env vars.
- **2026-10-25:** Deployed the per-pool swap indexer; kept user-facing trades/volume on GeckoTerminal pending coverage validation.

---

## 10. Tweet-ready facts (all LIVE unless noted; copy-rule safe)

1. Every Ballast launch puts 100% of supply into a locked pool. No team bag, no presale.
2. Launch opens at a fixed valuation — the same whether the treasury is empty or full.
3. A project can hold a real on-chain treasury of Chainlink-priced stock tokens, shown live as backing per token.
4. Holding a Ballast token gives no claim, redemption right, or entitlement to the treasury assets. The backing number is transparency, not a redemption.
5. 34,391,620 $BALLAST — 3.44% of supply — has been sent to the dead address (as of 2026-10-24).
6. The $BALLAST buyback is funded by the platform's fee share and sends tokens to the dead address. Anyone can trigger it. Burns can be zero.
6b. The buyback has run 84 times, sending 18,682,912 $BALLAST to the dead address (as of 2026-10-24).
7. The current swap fee is 3%, read live on-chain, split 80% creator / 20% platform. Fees can be zero.
8. Creators can withdraw only what they deposited, only after an immutable notice period, and every withdrawal is announced on-chain first.
9. Liquidity on every launch is permanently locked.
10. Pay with ETH into stock-paired pools — the router finds the route across venues at trade time.
11. Swap ETH into up to 6 stock tokens in one transaction with stock baskets.
12. Burn a token to vote for its community-default round-up stock. Votes are sent to the dead address and control no funds.
13. Round up a buy to also grab a little stock — delivered to your own wallet. Ballast takes nothing.
14. Launch a token from inside Telegram, signing with your own wallet. Non-custodial end to end.
15. Creators can split their fee share across a team with an immutable on-chain splitter.
16. Per-token fee routing with an asymmetric delay: lowering your own share is instant, raising it waits 7 days.
17. Open Treasury lets a community deposit into a shared treasury earning a share of trading fees. The share can be zero.
18. 18 tokens launched across four factory generations — older launches stay live and tradeable.
19. Backing is valued from the same Chainlink feeds anyone can verify, and it never reverts when a stock market is closed.
20. A fully on-chain 1,000-piece Manatee NFT, rendered entirely by an on-chain contract.
21. The whole app reads from the chain — swap fee, backing, burns, and splits are all live on-chain values, not hardcoded.
22. There's a `ballast-sdk` (preview) for building on Ballast: reads, quotes, writes, and events. *(Status: BUILT, preview.)*
23. Analytics shows volume, launches, pairing mix, and $BALLAST sent to the dead address — read straight from Robinhood Chain.
24. Self-backing is impossible by construction: a treasury can never hold the project's own token.
25. The contracts are not audited yet — stated plainly, on the record. *(Context fact, not a promotional claim.)*
