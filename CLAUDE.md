# CLAUDE.md — BALLAST

Persistent project context. Read this before every task.

---

## What this is

BALLAST is a token launchpad on **Robinhood Chain** where projects can hold a verifiable on-chain treasury of tokenized real-world assets. The value of that treasury is displayed live as **backing per token**.

Domain: `ballasted.xyz` · Marketing at root, app under `/app`.

Full product spec: `docs/BALLAST-build-spec.md`
Chain research and verified addresses: `docs/robinhood-chain-research.md`
Landing page copy: `docs/BALLAST-landing-copy.md`

When this file and the spec disagree, **this file wins** and you should flag the conflict.

---

## Hard rules — never violate these

These are not style preferences. Violating any of them either breaks the legal position of the product or corrupts every number it displays.

### Legal / copy

1. Never use **"floor", "guaranteed", "protected", "secured", "safe", "yield", "insured", or "returns"** in relation to ballast, in code comments, UI copy, variable names, or docs.
2. Never imply token holders can redeem or claim treasury assets. They cannot.
3. Never implement any reward, points, airdrop, referral cut, or benefit for depositing ballast. This would convert deposits into investment contracts.
4. Never take a platform fee on treasury deposits or on treasury AUM.
5. The disclaimer `Holding $TICKER gives no claim, redemption right, or entitlement to these assets` must render **inside** the backing panel, not in a footer.

### Valuation correctness

6. **Never revert on a stale price.** Robinhood tokenized equity feeds have no heartbeat off-hours. `require(block.timestamp - updatedAt < heartbeat)` bricks the product every weekend. Return a `stale` flag instead.
7. **Never apply `uiMultiplier()` to a Chainlink feed price.** The feed already includes it. Applying it again double-counts and inflates every backing figure.
8. Never smooth, interpolate, or forward-project a resting price.
9. Always read `decimals()` from the feed. Never hardcode.
10. Check the L2 sequencer uptime feed before trusting a price **when one exists** — but the feed is OPTIONAL, not a hard dependency. A hard requirement would brick valuation exactly like a reverting stale-check does, which this product forbids (valuation must never revert). Chain 4663 has **no** sequencer feed published (absent from the feeds directory and l2-sequencer-feeds page). So `BackingLens` takes the feed address in its constructor and, when it's `address(0)`, reports `sequencerStatus = Unknown` and **still values** — the UI must say "sequencer status unverifiable" and never imply it was checked. Down/GracePeriod (when a feed IS set) mark prices untrusted. Never hardcode a guessed sequencer address; setting a real one later turns the check on with no code change.

### Contract invariants

11. `ProjectTreasury.noticePeriod` is **immutable**. If it can be changed after deploy, the entire trust model collapses.
12. Creators may withdraw **only** what they deposited. Third-party deposits are permanently locked.
13. `require(asset != projectToken)` — self-backing must be impossible.
14. Allowlist assets by **canonical contract address**, never by ticker or name. Impostor tokens with matching tickers are a documented risk on this chain.

### Oracle feed sourcing

15. **Always use the feed's Standard Proxy, never the SVR Proxy.** Every Chainlink feed on this chain exposes TWO addresses: the Standard Proxy (`proxyAddress` in the feeds directory) and the SVR Proxy (`secondaryProxyAddress`). SVR = Smart Value Recapture, built for lending protocols recapturing liquidation OEV — wrong for a disclosure product. They sit side by side on the same docs row and are trivially easy to swap. On-chain they can look identical today (same `description`, `decimals`, underlying `aggregator`) yet diverge later, so a runtime check won't save you — get the address right at allowlist time. Verified example: SGOV Standard `0xa0DF4ee0fFf975306345875E3548Fcc519577A11`, SVR `0xa7a18Ca3F19E17FfA28F92302B817Ca8c1A94b06`.
16. **Feed `description()` has TWO on-chain formats on this chain — accept both.** Most read `Robinhood TICKER / USD` (a few, incl. SGOV/DELL/USAR, use `Robinhood TICKER-USD`), but some read `RHTICKER / USD` (verified 2026-07-28: NVDA, TSLA, MSFT, SPY — whose `proxyAddress` still matches the canonical Chainlink directory exactly). So the allowlist gate accepts **either `Robinhood <TICKER>` or `RH<TICKER>`**, both still requiring the exact ticker plus `USD`. `description()` is **not** the anti-impostor guard — anyone can deploy a contract returning any string; the real guard is sourcing the address from Chainlink's canonical directory (rule 15, matched exactly). The description check only catches paste errors, and the exact-ticker-plus-USD requirement still does that under either prefix. The exact description verified for each asset at approval time is recorded in `web/scripts/setAssets.ts` (`APPROVED_DESCRIPTIONS`) so later drift is detectable. Feeds also carry a `marketHours` field (e.g. `us_equities_24/5`). Store the market-hours class per asset in the registry. **Freshness is two-tier, not one blunt threshold:** a single `staleAfter` collapses RESTING (expected weekend close — information) and STALE (feed died mid-session — a warning), and they must never look the same. During trading hours anything over ~1h is stale; outside them it's resting up to the weekend/holiday gap. `staleAfter` on-chain is only the absolute outer bound; the RESTING-vs-STALE tier is computed off-chain from `marketHours` + `updatedAt` (`web/lib/marketHours.ts`), with raw `updatedAt` on-chain as the source of truth.
17. Only ~35 of ~95 stock tokens have a Chainlink feed (56 feeds total; the rest are crypto/stablecoin/exchange-rate). The allowlist is therefore **materially smaller** than the token registry: a stock token with no official feed cannot be ballast.

---

## Chain gotchas — Robinhood Chain

- Chain ID `4663` mainnet, `46630` testnet. Gas token ETH. Arbitrum Orbit L2.
- **The UniversalRouter on this chain is a modified fork** with an extra `minHopPriceX36` field in its v4 swap struct. Stock Uniswap SDK calldata **will revert**. Multiple look-alike routers exist — verify the address independently.
- Blocks are ~100 ms. **Use timestamps, not block numbers, for deadlines.**
- The sequencer is first-come-first-served. **Priority fees buy nothing.** Do not write fee-bidding logic.
- The public RPC is rate-limited. **Batch every read with Multicall3** and route UI reads through a Lens-style aggregator contract.
- Stock tokens are ERC-20 (18 decimals) implementing **ERC-8056**. They are not rebasing; corporate actions move `uiMultiplier()` instead of balances.
- Verify contracts with `forge verify-contract --verifier blockscout --chain-id 4663`.

---

## Conventions

- Solidity with Foundry. Tests in `test/`, one file per contract.
- **Write adversarial tests before happy-path tests.** The attack surface is the product.
- TypeScript strict mode. No `any`.
- Next.js App Router. Wallet providers wrap **only** the `/app` segment — never the root layout, or every marketing visitor downloads the web3 bundle.
- Never hardcode per-launch contract addresses. Resolve from creation events or the factory registry.
- Read owner-settable globals (fees, thresholds) live from contracts. Never hardcode economic parameters.
- Secrets come from env vars. Never commit a key, never inline an RPC URL with an API key.

---

## Division of labour

**You (Claude Code) write:** contracts, tests, indexer, frontend, scripts.
**The human handles:** running tests, filling `.env`, deploying, and all external accounts (RPC provider, X developer app, database).

So: when something needs a credential or an external account, **stop and write the required variable into `.env.example` with a comment explaining where to get it**. Do not invent placeholder keys or attempt to work around a missing secret.

---

## When to stop and ask

Stop and flag rather than proceeding if:

- A requested feature conflicts with any hard rule above.
- You need a contract address that is not in the research doc and cannot be resolved on-chain.
- A test fails in a way that suggests the spec itself is wrong.
- You are about to write anything that holds user funds and the approach is not covered by the spec.
