# Stock Basket — decisions log

Autonomous build on `feat/stock-basket`. Each entry: decision, alternatives considered, why. Most-recent last.

---

## 1. `ProjectTreasury.deposit()` can only ever be called by the creator's own EOA — no contract can do it on their behalf

**Finding (not really a "decision", but it determines every decision after it):** `ProjectTreasury.deposit(asset, amount)` is `onlyCreator`, which checks `msg.sender == creator` where `creator` is an `immutable` address fixed at launch to whoever called `BallastFactory.launch()` (`contracts/src/ProjectTreasury.sol:160-163`, `contracts/src/BallastFactory.sol:370`). There is no delegation, no operator role, no meta-tx support (no `_msgSender()` override), and nothing in `BackingLens` counts a raw `ERC20.transfer` straight to the treasury — `BackingLens.backingOf()` only reads `treasury.lockedBalance(asset)` and `treasury.creatorWithdrawable(asset)` (`contracts/src/BackingLens.sol:149-150`), both of which are only written by `deposit()` / `acceptDeposit()`. So:

- A contract calling `treasury.deposit()` directly reverts (`msg.sender` would be the contract's own address, never the creator's).
- Sending swap output straight to the treasury's balance (skipping `deposit()`) would NOT show up in `BackingLens` at all, and would be permanently stuck (not `creatorWithdrawable`, not `lockedBalance`) — worse than not building the feature.
- We are forbidden from touching/redeploying `ProjectTreasury` (HARD RULES), so this cannot be fixed by changing the treasury.

**Consequence:** no architecture — frontend-only or a new contract — can make the per-asset `deposit()` call for the creator. The creator must personally sign one `approve` + one `deposit` per asset, always, regardless of which option is chosen. The only thing automatable is getting ETH converted into the right stock tokens and landed in the creator's own wallet in one shot.

**How to apply:** this is why Option 2 is chosen below — not because it reduces the `deposit()` signature count (it can't), but because it's the only way to put real on-chain safety rails (minOut, Chainlink staleness + deviation, all-or-nothing, dust refund) around the swap step instead of trusting raw frontend-assembled calldata. See [[basket-option-decision]] below. The UI must say plainly: "1 signature to swap, then N confirmations to add each asset to your treasury" — never imply the whole basket lands in one signature.

---

## 2. Option 2 (BasketZap contract) chosen over Option 1 (frontend-only) {#basket-option-decision}

**Decision:** build `BasketZap.sol`.

**Alternatives considered:**
- *Option 1, frontend-only batched Universal Router calls.* Technically the swap leg alone CAN be done in one signature with no contract at all — Robinhood Chain's UniversalRouter v4 action encoding supports chaining multiple independent `SWAP_EXACT_IN_SINGLE` actions (one per leg, since every basket leg is WETH→stock-token, i.e. genuinely single-hop, not the multi-hop shape BALLAST deliberately avoids — see `contracts/src/interfaces/IRobinhoodV4Router.sol:20-25`) behind one shared `SETTLE_ALL(WETH, total)` and N `TAKE_ALL(asset_i, minOut_i)` actions, with outputs landing directly in the caller's wallet since `TAKE_ALL` pays out to whoever called `execute()` (confirmed by how `BallastV1Claim._swapEthForBallastV2` uses the identical 3-action shape and then explicitly forwards the result, because ITS caller is the contract, not an EOA — see `contracts/src/BallastV1Claim.sol:291-305`). So Option 1 is not "impossible".
- But every safety check the spec requires (fresh per-leg Chainlink staleness, the 20% deviation breaker, minOut enforcement, all-or-nothing revert, dust refund) would then have to live in the FRONTEND, which cannot be trusted at execution time — a client can be stale, tampered with, or simply skipped by calling the router directly. That is a real safety regression from every other swap path in this codebase (Open Treasury, V1Claim, BallastRouterV2) which all enforce these checks on-chain.
- Per the spec's own rule — "Option 2 only if Option 1 is impossible or needs more than 2 signatures" — the realistic minimum signature count for a basket of N assets is `1 (batched swap) + N (approve) + N (deposit)`, i.e. `1 + 2N`, under EITHER option, because of finding #1 above. For any N ≥ 1 that's already more than 2 signatures. So the letter of the rule routes to Option 2 regardless of N, and the substance of the rule (push on-chain what can be pushed on-chain) agrees independently.

**Why Option 2 is still worth building even though it can't reduce the irreducible `approve`+`deposit` cost:** it moves the ENTIRE swap leg (wrap ETH, multi-leg swap, per-leg Chainlink gate, minOut, refund, forwarding to the creator) into one audited, atomic, all-or-nothing call instead of raw frontend-built calldata. That is a strict safety improvement over Option 1 for the part of the flow that touches money before the creator even gets to the treasury.

**BasketZap never calls `ProjectTreasury.deposit()` itself** — it swaps and forwards the resulting stock tokens to the creator's own wallet in the same transaction (via explicit `safeTransfer`, exactly like `BallastV1Claim` forwards its swap output — it cannot rely on `TAKE_ALL`'s implicit recipient since BasketZap itself is the caller of `execute()`, not the creator). The creator then does their own `approve` + `deposit()` per asset afterward, same as if they'd never used BasketZap at all.

---
