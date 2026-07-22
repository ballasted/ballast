# BALLAST — Build Spec

> Launchpad with verified asset backing, on Robinhood Chain.
> Brand: **BALLAST** · Domain: **ballasted.xyz** · Handle: **@ballasted**
> This document is the source of truth. If something here conflicts with a default assumption, follow this document.

---

## 1. What this is

BALLAST is a token launchpad on Robinhood Chain where every project can hold a **verifiable on-chain treasury of tokenized real-world assets**, and the value of that treasury is displayed live as **backing per token**.

The differentiator is not safety, curation, or verification badges. It is one number that no other launchpad can produce:

```
backing per token = Σ(treasury asset balance × Chainlink price) / total supply
```

This is only possible because Robinhood Chain has tokenized equities and Chainlink price feeds as native primitives. Base and Solana do not, which is why Clanker, pump.fun, Bankr, and Virtuals cannot copy it without changing chains.

**Projects without a treasury are still allowed.** They display "No treasury · unbacked". This is a factual state, not a punishment. Do not gate, hide, rank down, or visually shame unbacked projects.

---

## 2. Critical constraint: this is disclosure, not a financial product

BALLAST displays treasury contents. It does **not** create any claim, redemption right, or promised return for token holders. Every design and copy decision must preserve this.

**Hard rules — do not violate these under any circumstances:**

1. Never use the words "floor", "guaranteed", "protected", "secured", "safe", "yield", "returns", or "insured" in relation to backing.
2. Never imply token holders can redeem, claim, or are entitled to treasury assets.
3. Never offer any reward, points, airdrop, referral cut, badge, or benefit in exchange for depositing to a treasury. This single change would convert deposits into investment contracts.
4. Never take a platform fee on treasury deposits or treasury AUM.
5. The disclaimer "Holding $TICKER gives no claim, redemption right, or entitlement to these assets" must appear inside the backing panel itself, not in a footer or ToS.
6. Never display a stale equity price as if it were current. See §6.

If a feature request conflicts with these rules, stop and flag it rather than implementing it.

---

## 3. Stack

- **Contracts:** Solidity, Foundry. Verify with `--verifier blockscout --chain-id 4663`.
- **Chain:** Robinhood Chain, Arbitrum Orbit L2. Mainnet chain ID `4663`, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `robinhoodchain.blockscout.com`. Testnet chain ID `46630`, faucet at `faucet.testnet.chain.robinhood.com`. Gas token is ETH.
- **DEX:** Uniswap v2, v3, v4 and UniswapX are all live on this chain and Uniswap is the primary public AMM. **Use v4 with a custom hook** for fee capture on graduated pools.
- **Oracles:** Chainlink. Read feed addresses, decimals and staleness parameters from `docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood` at build time — **never hardcode them from this document**.
- **Frontend:** Next.js (App Router), TypeScript, wagmi + viem, TailwindCSS.
- **Indexer:** Ponder or a subgraph for UI reads. On-chain values are the source of truth; if indexer and chain disagree, show the chain value.
- **Auth:** X (Twitter) OAuth 2.0 with PKCE. Scopes: `users.read`, `tweet.read` only. Never request write scopes.

### Chain-specific rules that will bite if ignored

- **⚠️ The UniversalRouter on Robinhood Chain is a modified fork.** Its v4 swap struct carries an extra `minHopPriceX36` field, so **calldata built with the stock Uniswap SDK will revert**. Multiple router look-alikes exist on this chain — verify the correct address independently before routing value through it.
- **Use timestamps, not block numbers, for deadlines.** Blocks are ~100 ms.
- **Priority fees buy nothing.** The sequencer is first-come-first-served and gas is negligible. Do not build fee-bidding logic.
- **The public RPC is rate-limited.** Batch all reads with `Multicall3` (canonical address `0xcA11bde05977b3631167028862bE2a173976CA11`) and ship a Lens-style aggregator contract so one call powers a whole screen. Plan for a paid RPC provider.
- **Canonical tokens:** WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. Verify both before use.

---

## 4. Contracts

### 4.1 `BallastFactory`

Deploys three contracts in one transaction:

1. **Project token** — ERC-20, fixed supply, mint authority renounced in the constructor. No admin mint, ever.
2. **Uniswap pool** + LP position, LP locked on graduation.
3. **`ProjectTreasury`** — address stored immutably on the token contract so it cannot be swapped later.

### 4.2 `ProjectTreasury`

```solidity
uint256 public immutable noticePeriod;   // locked at deploy — NEVER make this mutable
address public immutable projectToken;   // used to block self-backing
address public immutable creator;
```

**`noticePeriod` must be immutable.** If a creator can change it, they can advertise 90 days to earn trust and quietly reduce it to zero. This is the single most important invariant in the system.

#### Deposit accounting

Deposits are tracked per depositor:

```solidity
mapping(address => mapping(address => uint256)) public deposited; // depositor => asset => amount
uint256 public creatorWithdrawable; // = creator deposits − creator withdrawals
```

- **Creator deposits** are withdrawable, subject to the notice period.
- **Third-party deposits are permanently locked.** They can never be withdrawn by anyone, including the creator.

Without this rule, open deposits become a donation-to-rug pipeline: the public funds the treasury and the creator drains it.

#### Third-party deposit queue

Third-party deposits do not enter the treasury directly. They sit in a pending queue:

```solidity
function proposeDeposit(address asset, uint256 amount) external;   // anyone
function acceptDeposit(uint256 id) external onlyCreator;           // within 7 days
function declineDeposit(uint256 id) external onlyCreator;          // returns funds
function reclaimExpired(uint256 id) external;                      // auto-return after 7 days
```

This exists so a creator cannot be forced to accept assets from a tainted or sanctioned address.

Each `proposeDeposit` call must include `bytes32 disclosureVersion` — a hash of the exact disclosure text the depositor confirmed. Store it. If the disclosure text changes later, the old version stays on record.

#### Two-phase withdrawal

```solidity
function announceWithdrawal(address asset, uint256 amount) external onlyCreator; // sets unlockAt = now + noticePeriod
function executeWithdrawal(uint256 id) external onlyCreator;                     // requires now >= unlockAt
function cancelWithdrawal(uint256 id) external onlyCreator;                      // allowed anytime
```

Rules:
- **Only one pending withdrawal at a time**, or cap total pending at the current withdrawable balance. Otherwise a creator can announce many withdrawals and execute selectively to obscure intent.
- Withdrawals may only draw from `creatorWithdrawable`, never from locked third-party deposits.
- The pending withdrawal queue must be exposed via a public view function so third parties can build alerts without permission.

#### Asset allowlist

A global registry, managed conservatively. Only assets with an official Chainlink feed on this chain may be deposited.

**Allowlist by canonical contract address, never by ticker or name.** Robinhood's own docs warn that a token with a matching name or ticker but a different contract address is not a genuine Stock Token. Impostor tokens are an explicitly documented risk on this chain, and a single fake asset in one treasury discredits every backing figure on the platform. Source addresses from the on-chain asset registry surfaced at `docs.robinhood.com/chain/contracts`.

Two mandatory blocks:
- `require(asset != projectToken)` — blocks self-backing, where a creator deposits their own token to create a circular valuation loop.
- Enforce a minimum deposit size to prevent dust-spam bloating the valuation loop and griefing gas on view functions.

The allowlist also automatically prevents circular backing between two BALLAST projects, since project tokens will never have official Chainlink feeds.

**Verify before building:** confirm whether stock tokens carry transfer restrictions or holder allowlists that would prevent a contract from holding them. The public docs do not answer this, and it is existential for BALLAST.

---

## 5. Valuation

```
backingPerToken       = Σ(balance[i] × price[i]) / totalSupply
lockedBackingPerToken = Σ(locked balances × price[i]) / totalSupply
backingRatio          = marketPrice / backingPerToken
```

Always compute and display **both** locked and creator-withdrawable backing separately, plus the total. Locked backing is the more meaningful figure because it cannot leave.

Also compute a **30-day time-weighted average backing** and display it beside the spot figure. This exposes a treasury that was topped up yesterday for marketing purposes versus one that has been stable.

Every Chainlink read must handle staleness — **but must never revert on it**:

```solidity
function priceOf(address asset) public view returns (uint256 price, uint256 updatedAt, bool stale) {
    (, int256 answer, , uint256 ts, ) = feed.latestRoundData();
    require(answer > 0, "invalid price");
    price = uint256(answer);
    updatedAt = ts;
    stale = (block.timestamp - ts) > staleAfter[asset];
}
```

**Do not write `require(block.timestamp - updatedAt < heartbeat)`.** Robinhood tokenized equity feeds have **no heartbeat during off-hours** — they hold the last published price over weekends and holidays. A reverting valuation function is bricked two days out of every seven. Return the flag; let the UI show it.

Also required before trusting any price:

- **Sequencer uptime check.** On an L2, feeds go stale during a sequencer outage while contracts still respond. Read the Chainlink L2 Sequencer Uptime Feed: `sequencerStatus == 0` means up, plus a grace period after recovery.
- **`oraclePaused()` on the stock token.** True while a corporate action is processing. Chainlink states this flag is advisory and not enforced on-chain, so treat `updatedAt` as the primary guard and this as an extra UI signal.
- **Read `decimals()` from the feed.** Most USD feeds are 8 decimals, but never hardcode.

**Never apply `uiMultiplier()` to the feed price.** `latestRoundData()` already returns the full multiplier-adjusted per-token price. Applying the multiplier again double-counts and inflates every backing figure on the platform. Only use `uiMultiplier()` if converting to underlying-share terms for display.

---

## 6. Market hours and corporate actions — read this carefully

Robinhood tokenized equity feeds run **24/5**: regular, pre-market, post-market and overnight sessions. Weekday nights *are* covered. The gaps are **weekends, market holidays, and thin overnight windows**, when the feed holds its last published price and publishes no heartbeat.

Requirements:

- The backing figure and its timestamp are a **single UI component**. They must never be rendered apart from each other.
- When a feed is resting, display: `Equities valued at last update · {date} {time} ET` with a distinct icon. Do not present a held price as a live one.
- Do not interpolate, smooth, estimate, or forward-project a resting price. The moment you smooth the number, you are making a claim.
- Different asset classes need different staleness bounds. Treat a tokenized T-bill and a tokenized equity differently; store `staleAfter` per asset rather than one global constant.

**Corporate actions.** Stock tokens implement ERC-8056. Dividends and splits do not change balances — they change `uiMultiplier()`. Because dividends are reinvested through the multiplier, a stock token tracks the **total return** of the underlying, so its feed price drifts above the headline share price over time. This is expected and is a genuinely good property for a project treasury: ballast compounds on its own.

Track `UIMultiplierUpdated` events, and read pending actions via `newUIMultiplier()` and `effectiveAt()` so the UI can warn that a treasury revaluation is scheduled.

---

## 7. X and website verification

**X:** OAuth 2.0 login only. This proves control of the account, not project legitimacy.

- Store the **numeric X user ID**, never the handle alone. Handles can be renamed and sold; the numeric ID is permanent. Resolve the handle for display on each render.
- Copy must read "X account linked" or "Verified account control" — never "Ownership verified", which reads as endorsement.
- Rate limit: one active launch per X ID, or a cooldown period. Without this, one person spins up burner accounts and spams launches.

**Website:** fetch server-side and require either a meta tag `<meta name="ballast-token" content="{code}">` or a file at `/.well-known/ballast.txt`. A URL format check alone is trivially faked.

**Link drift:** snapshot links at launch. If a website later becomes unreachable or an X account is renamed or suspended, surface a flag on the token page (e.g. "Website unreachable since {date}"). This closes the biggest hole in any badge system.

Micro-copy that must appear beside verified links: `Links verified by BALLAST. Not an endorsement.`

---

## 8. Information architecture

One Next.js project, one domain. Marketing site at the root, app nested under `/app`.

```
app/
  (marketing)/              ← route group, does not appear in URL
    layout.tsx              ← static, NO web3 providers
    page.tsx                ← landing (see landing copy doc)
    docs/[[...slug]]/       ← MDX
    terms/  privacy/
  app/
    layout.tsx              ← wagmi/viem providers + bottom nav
    page.tsx                ← redirect to /app/discover
    discover/
    create/
    portfolio/
    profile/
    token/[address]/
    project/[id]/
```

**Three rules that matter:**

1. **Wallet providers wrap only the `/app` segment.** If wagmi loads in the root layout, every marketing visitor downloads the web3 bundle before reading a word. The landing page must be static and fast.

2. **Token pages must be server-rendered with dynamic OG images.** `/app/token/{address}` is the unit people share on X. The OG image should render project name, backing per token, ratio, and ballasted status. A shared link with no preview is a lost acquisition.

3. **Docs ship on day one, not later.** For a product whose entire pitch is legibility, docs are part of the product. Minimum four pages: how ballast works, what ballast is not, contract addresses, and how to verify a treasury yourself without using this UI.

---

## 9. Screens

Mobile-first. Four bottom-nav destinations: **Discover · Create · Portfolio · Profile**.

### Discover
- Sort tabs (underline style): **Ballasted · Trending · New**. Ballasted is the default tab — this is what makes the positioning structural rather than cosmetic.
- Category chips (pill style): All · Index · Treasury · Meme. Two distinct shapes so sort and filter are never confused.
- Card contents: logo, name, verified check, ticker, category, price, % change, and a backing row showing `Backing $X · N× backing`. Projects without a treasury show `Not ballasted · no treasury` in muted grey.
- **On the New tab, do not render sparklines.** A token minutes old has no meaningful price history; a chart there invites false pattern-reading. Show elapsed time instead.
- Creators with no history show an amber note: `First launch · no track record yet`. This must be visually distinct from the green verified check. A new wallet is *unknown*, not *safe*.

### Create (3 steps)
1. **Project** — logo, name, ticker, category, description (required).
2. **Treasury** — segmented control `Ballast this launch` / `No treasury`, both equally prominent. Asset picker with amounts, notice-period selector (7/30/90 days), and a live preview of resulting backing per token. Explain in-line that withdrawals are announced publicly and delayed.
3. **Review** — summary, verified links, locked-on facts, and an amber notice: `Backing is disclosure only. You are not promising holders any claim, redemption, or return.`

### Token detail
- Market price large at top, chart, timeframe selector.
- **Verified backing panel** — split bar showing Locked forever vs Creator-withdrawable, each with its own per-token figure and total; combined backing per token; market-close timestamp; the no-claim disclaimer.
- 30-day average backing beside spot.
- Buy/Sell buttons pinned within thumb reach.
- If a withdrawal is pending, show an amber banner **above everything else**, including the project logo, with amount, countdown, and execution date.

### Public deposit (highest-risk screen)
Two steps. Deliberately high friction — this is the one place in the app where you add steps rather than remove them.

1. **Form** — project context, asset, amount, and an effect preview showing both backing per token and **locked backing** before → after. Amber block: `This is permanent. Third-party deposits can never be withdrawn — not by you, not by the creator. You receive no tokens, no claim, and no right to any return.` Note the 7-day review window.
2. **Confirm** — three separate checkboxes:
   - `I cannot withdraw this. Ever.`
   - `I receive no tokens, shares, claim, or promised return.`
   - `This project may fail and these assets may become worthless.`
   
   Then a text input requiring the user to type `NO CLAIM`. Button label: **`Deposit permanently`** — not "Confirm". The verb must carry the meaning.

### Deposit review (creator side)
Pending deposits with depositor address, amount, asset, and time remaining. **Attribute each depositor's holdings as a percentage of supply.** If a depositor holds a large share, show an amber warning: `Large holder. Accepting raises backing before they could sell.` Warn, do not block. After acceptance, this attribution becomes public on the project page.

### Portfolio
- Total value, P&L.
- **Backing exposure** — a split bar showing what share of the portfolio is backed vs unbacked, with both dollar figures.
- Tabs: Holdings / My launches. Each holding row shows its backing figure and ratio, or `Unbacked`.

### Project profile
- Pending-withdrawal banner at the very top when active.
- Stats: market cap, treasury, backing ratio.
- **Treasury history**: notice period, deposit count and total, withdrawal count and total, and **treasury retention %** (share of deposits still held). Do not include a "silent drains" counter — the contract makes silent drains impossible, so it would read zero for everyone and measure nothing.
- **Creator track record**: projects launched, still funded (e.g. "2 of 3"), active since. Anchor track record to the X account ID rather than the wallet where possible — an aged X account with real followers is far more expensive to fake than a fresh wallet.

---

## 10. Design system

Robinhood Wallet's design *language*, not a pixel clone. Do not copy their logo, exact layout, or trade dress. `Not affiliated with Robinhood Markets` must appear at launch confirmation and in the footer.

```
Background       #0A0C0B
Card             #101412
Border           #1C211E
Accent green     #00C805
Accent green bg  #0E2A12
Text primary     #F2F4F2
Text secondary   #C7CDBE
Text muted       #8A938D
Text faint       #5F665F
Negative         #FF5A52
Warning          #EF9F27
Warning bg       #1A1509
Warning border   #3D3114
```

Principles carried over: colour as functional language (green up, red down); large high-contrast primary figures with small muted secondary metrics; large tappable cards; one decision per screen; primary actions within thumb reach.

Radii: cards 13–14px, inputs 11px, buttons 14px, phone frame 30px.

### Vocabulary

The word "ballast" works as noun, verb, and adjective. Use all three — it is the product's native vocabulary:

| Form | Usage |
|---|---|
| Noun | "ballast" = the treasury assets themselves |
| Verb | "ballast a launch", "add ballast" = deposit assets |
| Adjective | "ballasted" = this project holds a verified treasury |

**But never let brand vocabulary replace plain language.** A first-time visitor must understand the product without learning a glossary. Always pair the branded term with the plain one on first appearance in any view:

- Good: `Ballasted · $0.0180 backing per token`
- Good: `Add ballast — deposit assets to this treasury`
- Bad: `Ballast ratio 2.4×` with no explanation anywhere on screen

Projects without a treasury are `Not ballasted`, never "unballasted" (awkward) and never anything pejorative.

---

## 11. Revenue

- **Primary:** 1% swap fee, split between creator, platform, and referrer.
- **Secondary:** flat launch fee, higher for backed launches.
- **Long-term:** licensing the verified-backing data feed to aggregators and terminals. This is the only dataset of its kind on this chain.

**Do not build:** treasury AUM fees (turns BALLAST into a regulated asset manager and directly reduces the backing it claims to surface) or paid verification badges (destroys the credibility the entire product rests on).

Expect volume far below pump.fun-style launchpads. Requiring real assets is a deliberately high bar. Dozens of quality launches, not thousands.

---

## 12. Build order

1. `ProjectTreasury` + tests. Cover: notice-period immutability, self-backing rejection, third-party deposits being permanently locked, deposit queue expiry, and withdrawal caps.
2. `BallastFactory` + token + pool deployment.
3. Chainlink integration with staleness handling and market-hours state.
4. Indexer.
5. Marketing site at root: landing, docs, terms, privacy. Static, no web3 bundle.
6. App under `/app`: Discover → Token detail → Create → Portfolio → Profile → Deposit flows.
7. Dynamic OG image generation for token pages.
8. X OAuth + website verification.

Write tests for the adversarial cases before the happy path. The attack surface here is the product.

---

## 13. Open items requiring human decisions

- **Legal review of the deposit screen copy, word for word** — not the concept, the exact sentences. This is where a dispute would begin.
- **Do stock tokens carry transfer restrictions or holder allowlists?** Not answered in public docs. If a contract cannot hold them, the entire ballast mechanism needs rethinking. Verify this first, before writing anything else.
- **Jurisdictional eligibility.** Stock tokens are described as available "in eligible regions". This directly constrains who can ballast a launch, and whether geo-blocking is required.
- Read Chainlink feed proxy addresses, decimals and per-asset staleness bounds from the Chainlink Robinhood feeds page at build time.
- Confirm the L2 Sequencer Uptime Feed address on this chain.
- Confirm the correct modified UniversalRouter address independently, and the exact v4 swap struct encoding including `minHopPriceX36`.
- Confirm whether Uniswap v4 hook deployment is permissionless here (hook-flag address mining).

See `robinhood-chain-research.md` for full sources and the verified technical findings behind this spec.
