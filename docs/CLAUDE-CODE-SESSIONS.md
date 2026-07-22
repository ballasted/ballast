# BALLAST — Claude Code Session Plan

Ordered sessions. **Run them one at a time.** Do not hand Claude Code the whole project in one prompt — the contracts are the part that holds other people's assets and cannot be patched after deploy, so they get their own undivided sessions.

Each session below has a paste-ready prompt and a **done when** checklist. Do not advance until the checklist passes.

Repo setup before you start:

```
ballast/
  CLAUDE.md                       ← auto-loaded context
  .env.example
  docs/
    BALLAST-build-spec.md
    robinhood-chain-research.md
    BALLAST-landing-copy.md
```

---

## Session 0 — Verify the blocker (do this first)

**Why:** if a smart contract cannot hold Robinhood Stock Tokens, the entire ballast mechanism is impossible and everything after this is wasted. The public docs do not answer this. Cost: one afternoon. Cost of skipping: the whole project.

**Prompt:**

> Read CLAUDE.md and docs/robinhood-chain-research.md.
>
> Write a Foundry script and a minimal test contract to answer one question on Robinhood Chain testnet: **can an arbitrary smart contract receive, hold, and transfer out a Robinhood Stock Token?**
>
> The script should:
> 1. Deploy a bare contract that can receive ERC-20s and transfer them out
> 2. Transfer a small amount of a stock token from my EOA to it
> 3. Read the balance back
> 4. Transfer it back out to my EOA
> 5. Read `uiMultiplier()`, `oraclePaused()`, `balanceOfUI()`, and `totalSupplyUI()` on the token and print them
> 6. Read the token's Chainlink feed via `latestRoundData()`, print price, decimals, and `updatedAt`, and print how old the price is
>
> Report clearly whether each step succeeded or reverted, and with what error. Do not build anything else.

**Done when:** you can state with certainty whether a contract can custody stock tokens. If it cannot, **stop and tell me** — the design needs rethinking before any more code is written.

---

## Session 1 — ProjectTreasury and its tests

The heart of the product. Give it a full session.

**Prompt:**

> Read CLAUDE.md and §4–§6 of docs/BALLAST-build-spec.md.
>
> Implement `ProjectTreasury` in Solidity with Foundry, exactly as specified. Then write the test suite.
>
> **Write the adversarial tests first**, before the happy path. At minimum:
> - `noticePeriod` cannot be changed after deploy by any caller or any path
> - the creator cannot withdraw more than they deposited
> - third-party deposits can never be withdrawn by anyone, including the creator
> - depositing the project's own token reverts
> - a non-allowlisted asset reverts
> - a deposit below the minimum reverts
> - a pending deposit auto-returns after the 7-day window
> - a withdrawal cannot execute before `unlockAt`
> - multiple pending withdrawals cannot exceed the withdrawable balance
> - a stale price does NOT revert the valuation function; it returns `stale = true`
> - valuation is correct when a feed is resting over a simulated weekend
> - `uiMultiplier()` is never applied on top of the feed price
>
> Use Foundry fuzz tests for the deposit and withdrawal accounting. Do not build the factory yet.

**Done when:** every adversarial test passes, and you have personally read the `noticePeriod` immutability test and the creator-withdrawal-cap test and understood them. These two are the whole trust model.

---

## Session 2 — Factory, token, bonding curve, graduation

**Prompt:**

> Read CLAUDE.md, §4 and §11 of the spec, and §5 of the research doc for the reference architecture.
>
> Implement:
> - `BallastFactory` — deploys token, bonding curve, treasury, and fee-share in one transaction; registers the project
> - the project token — fixed supply, mint authority renounced in the constructor, treasury address stored immutably
> - the bonding curve — virtual constant-product, native ETH in and out
> - graduation into a Uniswap v4 pool with a custom hook, with LP locked permanently
> - the asset allowlist registry, keyed by canonical contract address
>
> Follow the proxy pattern from the reference architecture: minimal-clone the token, beacon-proxy the per-launch contracts. Never hardcode per-launch addresses.
>
> Read all economic globals live from the factory. Write tests for the full lifecycle including graduation.
>
> Do not integrate the UniversalRouter yet — flag it as a separate task.

**Done when:** a token can be created, traded on the curve, and graduated in tests.

---

## Session 3 — Router integration (isolate this)

Kept separate because the modified router is the highest-risk integration on this chain.

**Prompt:**

> Read the UniversalRouter warning in CLAUDE.md and §4 of the research doc.
>
> Integrate post-graduation swaps through the Robinhood-modified UniversalRouter. Its v4 swap struct carries an extra `minHopPriceX36` field, so stock Uniswap SDK calldata reverts.
>
> First: write a script that reads the router's ABI from Blockscout at the address in .env and prints the exact swap struct. Do not guess the encoding from the Uniswap SDK.
>
> Then implement swap encoding against that verified ABI, with a test on testnet.

**Done when:** a real swap executes on testnet against a graduated pool.

---

## Session 4 — Lens contract and indexer

**Prompt:**

> Read CLAUDE.md and §5 and §9 of the spec.
>
> Implement a `BallastLens` read-aggregator so one call powers a whole screen: project state, treasury contents, backing per token, locked vs creator-withdrawable split, 30-day time-weighted average backing, pending withdrawals, and staleness flags per asset.
>
> Then set up a Ponder indexer for launches, trades, deposits, withdrawal announcements, and `UIMultiplierUpdated` events.
>
> Remember the public RPC is rate-limited — batch everything through Multicall3.

**Done when:** you can query full project state in one call.

---

## Session 5 — Marketing site

**Prompt:**

> Read CLAUDE.md, §8 of the spec, and docs/BALLAST-landing-copy.md.
>
> Build the Next.js project: marketing site at the root using a `(marketing)` route group, app shell under `/app`.
>
> The root layout must contain **no web3 providers** — wallet providers wrap only the `/app` segment.
>
> Build the landing page from the copy doc verbatim, including the "What ballast is, and is not" section at full size. Then docs pages in MDX, terms, and privacy.
>
> Use the design tokens in §10 of the spec.

**Done when:** landing page loads without any web3 bundle, and Lighthouse performance is good.

---

## Session 6 — App screens

**Prompt:**

> Read CLAUDE.md and §9–§10 of the spec.
>
> Build the app screens under `/app`: Discover (tabs Ballasted / Trending / New), token detail, create flow (3 steps), portfolio, project profile, public deposit flow, and creator deposit review.
>
> Follow the copy rules in §10 exactly — branded term always paired with plain language on first appearance.
>
> Token pages must be server-rendered with dynamic OG images showing project name, backing per token, ratio, and ballasted status.
>
> Pending-withdrawal banners render above everything else on a project page, including the logo.

**Done when:** every screen renders against testnet data and a shared token link produces a correct OG preview.

---

## Session 7 — Verification

**Prompt:**

> Read CLAUDE.md and §7 of the spec.
>
> Implement X OAuth 2.0 with PKCE, scopes `users.read` and `tweet.read` only. Store the **numeric X user ID**, never the handle alone — handles can be renamed and sold. Resolve the handle at render time.
>
> Implement website verification: fetch server-side, require a `<meta name="ballast-token">` tag or `/.well-known/ballast.txt`.
>
> Implement link-drift detection: snapshot links at launch, flag when a site becomes unreachable or an X account is renamed or suspended.
>
> Rate limit: one active launch per X ID.

**Done when:** an unverified project cannot launch.

---

## Session 8 — Adversarial review

Do this before mainnet, in a fresh session with no prior context.

**Prompt:**

> Read CLAUDE.md and the full spec. You have not seen this codebase before.
>
> Review it as an attacker. Specifically try to find a way to:
> - change `noticePeriod` after deploy
> - withdraw third-party ballast
> - withdraw more than was deposited
> - inflate a backing figure using self-backing, a fake asset, or a multiplier bug
> - brick the valuation function
> - launch without verified links
> - drain funds through the router integration
>
> Report findings by severity. Do not fix anything yet — list them first.

---

## Your checklist as it runs

- [ ] Session 0 answered: contracts **can** hold stock tokens
- [ ] `.env` filled for testnet
- [ ] Every adversarial test in Session 1 passes
- [ ] Uniswap v4 and router addresses verified independently on Blockscout
- [ ] Sequencer uptime feed address confirmed from Chainlink docs
- [ ] External review of `ProjectTreasury` by a Solidity engineer
- [ ] Deposit screen copy reviewed by a lawyer, word for word
- [ ] Stock token transfer restrictions confirmed (or ruled out)
- [ ] Jurisdiction and geo-blocking decided
- [ ] 3–5 real projects committed to ballast at launch
