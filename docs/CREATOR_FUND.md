# BALLAST Creator Fund

A public campaign + eligibility tracker. The first **10** tokens to reach **$50,000
cumulative swap volume** and **100 holders** within **14 days of launch** each receive
**$1,000 in stock tokens deposited into the token's treasury** (total cap $10,000).

Everything is computed from on-chain events — **not** the Analytics page (known
volume bug). Nothing in this system signs or broadcasts anything.

---

## Rules (source of truth: `web/lib/creatorFund.ts`)

- **Eligible token:** launched on the current factory (gen-4+) at/after
  `CAMPAIGN_START`, not hidden/retired, with **≥1 pool quoted in NVDA, SPY or SGOV**
  (WETH-only launches are not eligible).
- **Milestones (within 14 days of the launch block ts):** $50k cumulative swap volume
  (USD) **and** 100 holders.
- **Prize order:** first 10 to reach BOTH, ordered by the timestamp the **second**
  condition was met.
- **One entry per creator:** if a creator has several qualifying tokens, only the
  first (earliest second-milestone time) counts; later ones become review candidates.
- **Prize:** $1,000 of stock tokens (default **SGOV**) deposited into the token's
  treasury — not the creator wallet.
- **Claiming:** winners receive the deposit as a **proposal** to their token's
  treasury and must **accept it from the creator wallet within 7 days** (on the
  token's Backing page), else it returns to the Safe. Once accepted it is locked
  forever and never withdrawable.

---

## Files

| Path | Purpose |
|---|---|
| `web/lib/creatorFund.ts` | **Single config** — rules, eligible quotes, prize, disclosure, types, pure helpers. |
| `web/lib/creator-fund/pricing.ts` | Per-block USD pricing (ETH/USD + registry feeds). |
| `web/lib/creator-fund/volume.ts` | Volume aggregation + $50k milestone timing. |
| `web/lib/creator-fund/holders.ts` | Holder counting, 100-holder milestone, cluster flags. |
| `web/lib/creator-fund/wash.ts` | Self-dealing + wash-loop flagging. |
| `web/lib/creator-fund/exclusions.ts` | Holder-exclusion address set. |
| `web/lib/creator-fund/scan.ts` | Orchestration: discover → scan → build leaderboards. |
| `web/lib/creator-fund/data/*.json` | Committed scanner output the app imports. |
| `scripts/creator-fund/scan.ts` | Runnable, incremental scanner (reads `RH_RPC_URL_PAID`). |
| `scripts/creator-fund/payout.ts` | Safe Transaction Builder JSON generator. |
| `scripts/creator-fund/confirmed-winners.json` | **Human-committed** winners list. |
| `web/app/app/creator-fund/page.tsx` | Public campaign page. |
| `web/app/app/creator-fund/admin/page.tsx` | Env-gated admin review page. |

---

## Running the scan

From the repo root:

```bash
npx tsx scripts/creator-fund/scan.ts
```

- Reads the chain via **`RH_RPC_URL_PAID`** (by name), falling back to
  `RPC_UPSTREAM_URL`, then the public RPC. Secrets are never printed.
- **Re-runnable + incremental:** per-token last-scanned block is cached in
  `data/creator-fund/state.json` (gitignored), so a re-run only fetches new blocks.
  Delete that file for a full rescan.
- Writes `web/lib/creator-fund/data/leaderboard.json` (public, no flag detail) and
  `admin.json` (adds flags), and mirrors `confirmed-winners.json` into the web bundle.
- Set `NEXT_PUBLIC_CREATOR_FUND_START` before scanning (0 ⇒ empty output).
- Run on a schedule (cron / Vercel cron calling the script, or GitHub Action) to keep
  the page fresh; commit the updated `data/*.json` to deploy a new snapshot.

---

## USD pricing method (this decides the money)

For each swap we value the **quote side** (the asset with an authoritative oracle),
priced **at the swap's block**:

- **WETH quote** → Chainlink **ETH/USD Standard** feed
  `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`.
- **Stock quote (NVDA/SPY/SGOV/…)** → that asset's feed from
  `AssetRegistry.assetConfig(asset).feed` (Standard proxy — never SVR).
- Price = `latestRoundData().answer` read at the swap's block number (archive read),
  scaled by the feed's own `decimals()` (never hardcoded; `uiMultiplier` never applied).
- `USD(swap) = (quoteAbs / 10^quoteTokenDecimals) × (answer / 10^feedDecimals)`.
- A swap whose quote has no resolvable feed is reported as **unpriced** (counted as
  neither volume nor $0) and surfaced in the admin review notes.

Volume is the sum of in-window priced swaps across **all** of a token's quote pools
(Swap events on the v4 PoolManager singleton, filtered to the token's pool ids). The
trader is the **real EOA** (`tx.from`), not the router `sender`.

---

## Holder counting + exclusions

Holders are reconstructed from the token's ERC-20 `Transfer` events (net balance per
address); we count non-zero balances **excluding**:

- Zero address and `0x…dEaD`.
- Protocol Safe `0xEFC9…C079`, the compromised deployer EOA `0xA277…37D1`, Permit2.
- PoolManager `0x8366…0951`, UniversalRouter, BallastRouter v1/v2.
- FeeRouterFactory v1/v2, BuybackBurner (gen2/3) + BuybackBurnerV2, platform vault
  (gen1), BasketZap, the Ramses locker, WETH.
- Per-generation BallastSeeders (gen1–4), all factories + hooks.
- **Per-token:** the token's own treasury and creator wallet (and its fee router /
  team-split recipients when resolvable).

The exact list is `web/lib/creator-fund/exclusions.ts` (with env overrides). The
100-holder milestone time is the first in-window moment the clean count reaches 100.

**Cluster flags:** holders whose first inbound transfer came from the same
**non-system** source wallet (≥3 sharing a source) are flagged as a possible
sybil/airdrop cluster — flagged for review, never removed.

---

## Wash / self-dealing flags

Flags **never remove** a swap from the raw total — the scanner reports both **raw
volume** and **volume excluding flagged**, and the admin page lists every flag so you
decide what counts.

- **Identity:** trader = creator / treasury / a team-split recipient / a wallet funded
  by the creator within the window.
- **Wash loop:** the same wallet does an **opposite-side** swap within 1 hour of
  another (both legs flagged).

A token that only clears $50k *with* flagged volume is marked **needs review**
(`disqualified_candidate`), not auto-qualified.

---

## Admin review + confirming winners

- `/app/creator-fund/admin` — gated by server-only `CREATOR_FUND_ADMIN=true` (404s
  otherwise; never linked). Shows every candidate with all flags and review notes.
- A token becomes a **winner** only when you add it to
  `scripts/creator-fund/confirmed-winners.json` and commit it:

```json
{
  "winners": [
    { "token": "0x…", "prizeAsset": "0x92FD…F9B5", "note": "reviewed 2026-11-20" }
  ]
}
```

The spots countdown on the public page is `10 − confirmed.length`.

---

## Prize lifecycle — exact contract behaviour

Answers below are from `contracts/src/ProjectTreasury.sol`.

**After `acceptDeposit()`, can the creator ever withdraw those assets?** **No — never**, not through the notice period, not ever. `acceptDeposit` credits `lockedBalance`, and the withdrawal path draws *only* from `creatorWithdrawable`:

```solidity
function acceptDeposit(uint256 id) external onlyCreator nonReentrant {
    ...
    p.status = PendingStatus.Accepted;
    lockedBalance[p.asset] += p.amount;          // ← locked, not withdrawable
    deposited[p.depositor][p.asset] += p.amount;
    ...
}
function announceWithdrawal(address asset, uint256 amount) external onlyCreator ... {
    uint256 available = creatorWithdrawable[asset];          // ← only this
    if (amount > available) revert ExceedsWithdrawable(amount, available);
    ...
}
function executeWithdrawal(uint256 id) external onlyCreator nonReentrant {
    uint256 available = creatorWithdrawable[w.asset];        // ← only this
    ...
    creatorWithdrawable[w.asset] = available - w.amount;
    IERC20(w.asset).safeTransfer(creator, w.amount);
}
```

No function anywhere moves `lockedBalance` out (the contract's own doc: *"Third-party deposits are permanently locked. No function — not even onlyCreator — can move them out."*). `heldBalance = lockedBalance + creatorWithdrawable`, so the prize shows as backing but is unwithdrawable.

**If the creator doesn't accept within 7 days, what happens to the SGOV?** It is **refundable to the Safe**, by **anyone** (permissionless), via `reclaimExpired` once `ACCEPT_WINDOW` (7 days) has passed — not stuck:

```solidity
uint256 public constant ACCEPT_WINDOW = 7 days;

function reclaimExpired(uint256 id) external nonReentrant {
    PendingDeposit storage p = pendingDeposits[id];
    if (p.status != PendingStatus.Pending) revert BadState();
    if (block.timestamp <= uint256(p.proposedAt) + ACCEPT_WINDOW) revert WindowOpen();
    p.status = PendingStatus.Reclaimed;
    emit DepositReclaimed(id, p.depositor, p.asset, p.amount);
    IERC20(p.asset).safeTransfer(p.depositor, p.amount);   // ← back to the Safe (the depositor)
}
```

**Can the proposer (the Safe) cancel its own pending proposal?** **No** — there is no proposer-initiated cancel before the window ends. The only exits for a `Pending` proposal are: the **creator** `acceptDeposit` or `declineDeposit` (both `onlyCreator`), or — after 7 days — anyone calling `reclaimExpired`. So the Safe either waits for the creator to act, or waits out the 7 days and reclaims (or has the creator decline for an immediate refund):

```solidity
function declineDeposit(uint256 id) external onlyCreator nonReentrant {
    ...
    p.status = PendingStatus.Declined;
    IERC20(p.asset).safeTransfer(p.depositor, p.amount);   // ← immediate refund to the Safe
}
```

The scanner tracks this live from the treasury's `DepositProposed/Accepted/Declined/Reclaimed` events (depositor = the Safe) and surfaces **proposed / accepted / expired / reclaimed / declined** per winner (public "Funded" badge + admin detail with tx links). The Backing page (`/app/backing/<token>`) shows any pending proposal to everyone and gives the connected **creator** an Accept/Decline button (`acceptDeposit`/`declineDeposit`).

## Payout (Safe) — important

`ProjectTreasury.deposit()` is **`onlyCreator`** — the Safe is not any token's creator,
so it **cannot** call it. The only path for a third party (the Safe) to fund a
treasury is **`proposeDeposit(asset, amount, disclosureVersion)`**, after which the
token's **creator must call `acceptDeposit(id)` within 7 days** (`ACCEPT_WINDOW`), at
which point the funds are **permanently locked** (`lockedBalance`, never withdrawable).
That matches the campaign copy exactly: the prize increases displayed backing and
confers no claim. If the creator doesn't accept in 7 days, anyone can
`reclaimExpired(id)` and the funds return to the Safe.

Generate the batches:

```bash
npx tsx scripts/creator-fund/payout.ts
```

For each confirmed winner it writes `scripts/creator-fund/payouts/<token>.json` — a
Safe Transaction Builder batch (Safe `0xEFC97e16a24d2434C7138a2634E554a0631aC079`)
with two transactions:

1. `approve(treasury, amount)` on the prize asset.
2. `treasury.proposeDeposit(prizeAsset, amount, PRIZE_DISCLOSURE_VERSION)`.

The $1,000 amount is priced from the asset's Chainlink feed at generation time (SGOV
is ~stable, so it stays close to $1,000 until you sign). The script prints the exact
amount + price used and must clear `registry.minDeposit`. **It never signs or
broadcasts** — import the JSON in Safe → Transaction Builder, review, and sign
yourself. After execution, record the tx hash in `confirmed-winners.json`
(`funded.txHash`) and re-run the scanner so the page shows a **Funded** badge, and
remind the creator to **accept** the deposit within 7 days.

---

## Telegram alerts (optional)

Set `CREATOR_FUND_TG_ENABLED=true` (reusing `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`).
When a token first qualifies, the scanner posts
`"<TOKEN> just qualified for the Ballast Creator Fund, pending review."` once per token
(deduped via scan state; honors `TG_DRY_RUN`).

---

## Tests

```bash
cd web && npx vitest run lib/creator-fund lib/creatorFund.test.ts
```

Deterministic unit tests cover volume aggregation + milestone timing, holder counting
+ exclusions + clusters, wash/self-dealing flags, and the status/ranking logic. A
**fork test** (`lib/creator-fund/fork.test.ts`) runs only when `RH_RPC_URL_PAID` (or
`RPC_UPSTREAM_URL`) is set, exercising real Chainlink feed resolution + pricing and
holder reconstruction/exclusion on live data for existing tokens:

```bash
RH_RPC_URL_PAID=https://… npx vitest run lib/creator-fund/fork
```

---

## Limitations (honest)

- **"Funded by creator"** uses token-transfer funding only; native-ETH funding is not
  traced (would need tx tracing). Flagged for review, not decisive.
- Team-split recipients are resolved best-effort; verify on the admin page before
  paying if a creator uses a splitter.
- The first full scan over a token's 14-day window is heavy on `eth_getLogs`; use a
  paid RPC. Subsequent runs are incremental.
