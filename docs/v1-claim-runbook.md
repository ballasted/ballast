# v1 -> v2 migration claim — runbook

Everything computed and built this session. Two Safe signatures needed before
this goes live; everything else is done or is a command for you to run.

## The numbers (real, computed from the committed snapshot + historical chain reads)

- 71 holders, snapshot block `73,030,228`, TWAP `$0.000007100633157926953`/v1 token.
- Historical ETH/USD at that exact block (read live via `cast call ... --block 73030228`): **$2,686.81**.
- Per-holder ETH amounts: `data/snapshot/v1_claim_eth.csv` (also `v1_claim_eth_meta.json`).
- **Total ETH needed: 0.693084308357578318 ETH** (~$1,862 at snapshot-time ETH price).
- Merkle tree (leaf = `keccak256(keccak256(abi.encode(address, snapshotBalanceWei, ethAmountWei)))`, OZ-compatible sorted-pair internal hashing): `data/snapshot/v1_claim_merkle.json`. **Root: `0xaf7393f645e01091ca3988179054cf9dc71c6bb87008cbb4c1d1546f1fee4bbb`**. Self-verified: all 71 proofs independently reconstruct the root (`data/snapshot/build_merkle.cjs`).

## Contract — built, tested, not yet deployed

`contracts/src/BallastV1Claim.sol` — immutable, no owner, no admin function at
all. **Final spec (supersedes the first version built earlier this session):**
7-day claim window (not 30), and each holder picks ONE payout path the first
time they claim anything, locked in forever after:
  - `claimETH` — pays ETH directly, exactly as originally built.
  - `claimToken` — swaps the ETH entitlement into $BALLAST v2
    (`0xDc605041F02e41CbD8FDC347023e93C4c3fA243C`) through its real WETH pool
    (hook `0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc`), via the same
    UniversalRouter-fork encoding BallastRouter v1 proved on mainnet, and
    sends the tokens straight to the holder in the same transaction. Caller
    supplies `minOut` (contract rejects 0 outright). If the swap can't clear
    it, the ENTIRE claim reverts — including the v1 burn — so nothing is ever
    marked claimed on a failed swap.

23/23 mock-suite tests green (`contracts/test/BallastV1Claim.t.sol`):
double-claim, wrong proof, wrong amounts, non-leaf caller, partial claims (incl.
a 7-way uneven split proving zero rounding-dust loss), sold-after-snapshot
(caps entitlement, no special-case code needed — plain ERC20 balance
enforces it), bought-more-after-snapshot (gets nothing extra), sweep
before/after deadline, permissionless sweep, zero-balance sweep no-op,
reentrancy on the ETH payout (blocked by `ReentrancyGuard`), constructor
zero-address guards (now covering all 7 immutable addresses), the one-path
lock, a zero-minOut revert, and the invariant that the contract never holds
v1 at any point in any path.

10/10 **mainnet fork tests** green (`contracts/test/BallastV1ClaimFork.t.sol`,
run with `RH_RPC_URL_PAID` set), against the REAL live $BALLAST v2 WETH pool
and two real snapshot holders (the largest and second-largest entitlements):
both paths end-to-end, one-path-per-holder enforced in both directions, a
too-high `minOut` reverting the entire claim with zero state touched, claim on
day 6 succeeding, claim on/after day 7 reverting, sweep before/after the
deadline, and the total-ETH-out-never-exceeds-budget invariant across both
paths. The full 71-holder sum (`693084308357578318` wei) is verified
off-chain in `data/snapshot/build_merkle.cjs`, re-checked this session.

## Deploy — new keystore, never the old deployer

A brand new keystore was created THIS session specifically for this one
deploy: **`v1claim-deployer`**, address
**`0x27EC8D16E5E2f5fcf7A41e87a25652773782C391`**, password at
`~/.foundry/v1claim-deployer.pass` (never printed, chmod 600, readable only
by your user). It has never signed anything and never will again after this
one deploy.

**Its future contract address is already known** (CREATE is deterministic —
confirmed via `cast compute-address` and matched by the deploy script's own
dry-run): **`0xb8a42D1DC608dad8CbE6E7b0029067D2A932DFFE`** — this is ONLY
correct as long as this wallet's very first transaction ever is the deploy
below (nonce 0). Don't send anything else from it first. CREATE addresses
depend only on (deployer, nonce) — constructor arguments never change it — so
this address is unaffected by the deadline/swap-path changes below. Re-checked
live this session: nonce is still 0, wallet balance is still 0.

### Step 1 — Safe: fund gas (0.001 ETH, ~40x the estimated 0.0000253 ETH deploy cost)

`docs/safe-tx-fund-v1claim-deployer-gas.json` — import and sign.

### Step 2 — deploy (I can run this once gas lands; or run it yourself)

```bash
cd contracts
export V1_TOKEN=0x069a260370C61d91bd3e9842d81D378F9750F7F3
export MERKLE_ROOT=0xaf7393f645e01091ca3988179054cf9dc71c6bb87008cbb4c1d1546f1fee4bbb
export SWEEP_TO=0xEFC97e16a24d2434C7138a2634E554a0631aC079
# CLAIM_DEADLINE_DAYS defaults to 7 now (was 30) -- leave unset unless you
# want something else. $BALLAST v2/WETH/hook/UniversalRouter/Permit2 are
# hardcoded constants in the script itself (same convention as
# DeployBuybackV2.s.sol) -- nothing else to set.
# dry run first (no key needed):
forge script script/DeployV1Claim.s.sol:DeployV1Claim --rpc-url $RH_RPC_URL_PAID --sender 0x27EC8D16E5E2f5fcf7A41e87a25652773782C391
# then broadcast:
forge script script/DeployV1Claim.s.sol:DeployV1Claim --rpc-url $RH_RPC_URL_PAID \
  --account v1claim-deployer --password-file ~/.foundry/v1claim-deployer.pass --broadcast
```

Confirm the deployed address really is `0xb8a42D1DC608dad8CbE6E7b0029067D2A932DFFE`
(`cast code <addr>` returns non-empty) before Step 3.

### Step 3 — Safe: fund the contract with the full ETH budget

`docs/safe-tx-fund-v1claim.json` — already has the exact address + exact
amount (0.693084308357578318 ETH) filled in. Import and sign AFTER Step 2
confirms.

### Step 4 — verify on Sourcify (works from this sandbox, confirmed this session)

```bash
cd contracts
forge verify-contract 0xb8a42D1DC608dad8CbE6E7b0029067D2A932DFFE src/BallastV1Claim.sol:BallastV1Claim \
  --verifier sourcify --chain-id 4663 --rpc-url $RH_RPC_URL_PAID --guess-constructor-args
```

## Built this session — `/app/migrate`

`web/app/app/migrate/page.tsx` + `web/hooks/useV1Claim.ts`: connect wallet ->
snapshot balance / current v1 balance / claimed-so-far / deadline countdown ->
a percentage slider -> pick ETH (recommended) or $BALLAST v2 (locked in
forever once either is used) -> approve v1 -> claim -> receipt with a
Blockscout tx link. Choosing $BALLAST v2 shows a live quote
(`useBallastV2TokenQuote`, same V4Quoter + StateView pattern the trading UI
uses) — amount out, price impact, a slippage preset, and the resulting
`minOut`, which the contract rejects at 0. "Not in the snapshot" state for
addresses that weren't included; a "claim window closed" state once the
7-day deadline passes. A public "Migration progress" section (claimed %, ETH
value paid across BOTH paths, v1 burned, unique holders claimed) swept live
from `Claimed`+`ClaimedToken` events, visible without connecting a wallet.
Proofs served from a static file, `web/public/data/v1-claim-merkle.json`
(copied from `data/snapshot/v1_claim_merkle.json`, same content, unaffected
by this session's contract changes). Gated on `NEXT_PUBLIC_V1_CLAIM_ADDRESS`
— shows an honest "not live yet" state until that's set post-deploy.
`tsc --noEmit` clean, `vitest` 76/76 green.

**Not yet added to nav** — a parallel session task is mid-edit on
`web/components/app/nav-items.tsx` (removing Terminal/Analytics); add a
`/app/migrate` entry there once that lands, to avoid a merge collision.

## Still to build

- Announcement tweet: drafted, `docs/v1-migration-announcement-draft.md` —
  needs the real contract address before posting.
- A dedicated public snapshot/methodology page (CSV download + hash + root +
  contract address, all already linked/shown on `/app/migrate` itself, but a
  separate `/docs/...` page could hold the fuller narrative if wanted).
