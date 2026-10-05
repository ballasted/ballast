# Open Treasury — deployment

Status: contracts built and tested (`docs/OPEN_TREASURY_DESIGN.md`), deploy
script written, **not deployed**. Nothing in this doc has been broadcast.
Dry-run against mainnet state could not be executed from this sandbox (see
§3) — the commands below are correct and ready to run from a machine with
real RPC access.

---

## 0. What this deploys

Two new, additive contracts only — nothing existing is touched, modified, or
redeployed:

- `OpenTreasuryVaultFactory` — permissionless, no owner. Constructor wires it
  to the real, live `BallastFactory`, `AssetRegistry`, and WETH, plus the two
  immutable parameters `minHoldTime` (24h) and `rewardsDuration` (7d).
- `OpenTreasuryLens` — read-only, composes the real, live `BackingLens`
  unmodified.

## 1. Prerequisites

- **A fresh deploy wallet**, created specifically for this deploy. Must NOT be
  `0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1` (compromised) or depend on it
  in any way.
- A Foundry keystore for that wallet: `cast wallet import opentreasury-deployer
  --interactive` (you will be prompted for the private key and a password —
  Claude Code never sees or handles either).
- The wallet funded with a small amount of ETH for gas (see §3 for the
  estimate once a dry-run has actually run).
- `RH_RPC_URL_PAID` (or any working mainnet RPC) set in your own shell — never
  pasted into chat, never committed.

## 2. Exact commands, in order

**Step 1 — dry run (no `--broadcast`), confirm predicted addresses and gas:**
```bash
forge script script/DeployOpenTreasury.s.sol:DeployOpenTreasury \
  --rpc-url "$RH_RPC_URL_PAID"
```
Read the predicted `OpenTreasuryVaultFactory`/`OpenTreasuryLens` addresses and
total gas from the output before proceeding. See §3 for why this sandbox
could not run this step itself this round.

**Step 2 — broadcast, signed by the keystore:**
```bash
forge script script/DeployOpenTreasury.s.sol:DeployOpenTreasury \
  --rpc-url "$RH_RPC_URL_PAID" \
  --account opentreasury-deployer \
  --password-file ~/.foundry/keystores/opentreasury-deployer.pass \
  --broadcast
```

**Step 3 — verify both contracts on Blockscout:**
```bash
forge verify-contract <FACTORY_ADDRESS> \
  src/OpenTreasuryVaultFactory.sol:OpenTreasuryVaultFactory \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain-id 4663 \
  --constructor-args $(cast abi-encode "constructor(address,address,address,uint256,uint256)" \
    0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67 \
    0x427764d0d19aB765c35A41A5aa4771580307dA81 \
    0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 \
    86400 604800)

forge verify-contract <LENS_ADDRESS> \
  src/OpenTreasuryLens.sol:OpenTreasuryLens \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain-id 4663 \
  --constructor-args $(cast abi-encode "constructor(address)" 0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770)
```

**Step 4 — verify on Sourcify** (same artifacts, no constructor-args flag needed —
Sourcify recovers them from the on-chain creation bytecode):
```bash
forge verify-contract <FACTORY_ADDRESS> src/OpenTreasuryVaultFactory.sol:OpenTreasuryVaultFactory \
  --verifier sourcify --chain-id 4663
forge verify-contract <LENS_ADDRESS> src/OpenTreasuryLens.sol:OpenTreasuryLens \
  --verifier sourcify --chain-id 4663
```
(Per `foundry.toml`'s own note: do not re-add an `[etherscan]` block before
trying this — it silently hijacks non-Etherscan verifiers. Already removed,
just don't reintroduce it.)

## 3. Dry-run — what this session could and couldn't confirm

The dry-run command in Step 1 was attempted from this sandbox against the
documented public RPC (`https://rpc.mainnet.chain.robinhood.com`,
`docs/robinhood-chain-research.md`) and failed at the network layer:
```
Error: error sending request for url (https://rpc.mainnet.chain.robinhood.com/)
Error #1: invalid peer certificate: NotValidForName
```
This is a TLS/certificate issue specific to this sandbox's outbound network
(not a statement about the chain or RPC itself — memory from a prior session
recorded the same public RPC as reachable). **Predicted addresses, total gas,
and ETH needed at current gas price are therefore Unknown from this session** —
run Step 1 yourself before Step 2 and read those numbers from its output; the
script prints the factory's `implementation()` address too, so you can confirm
the clone implementation deployed correctly before broadcasting anything.

What IS confirmed from this session: the script compiles cleanly against the
same Foundry profile as every other contract in this repo (`forge build`,
exit 0), and `OpenTreasuryVaultFactory`/`OpenTreasuryLens`'s own constructors
contain no logic beyond wiring immutables — the actual deploy gas cost is
bounded by `OpenTreasuryVault`'s and `OpenTreasuryLens`'s compiled
deployment sizes, both well within normal single-contract deploy ranges (see
the Phase 4 gas report in the final report for the clone/function-level
numbers already measured against local state).

## 4. Vercel environment variables

Set after Step 2 confirms both addresses on-chain:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_OPEN_TREASURY_FACTORY_ADDRESS` | `<FACTORY_ADDRESS>` | from Step 2 output |
| `NEXT_PUBLIC_OPEN_TREASURY_LENS_ADDRESS` | `<LENS_ADDRESS>` | from Step 2 output |
| `NEXT_PUBLIC_OPEN_TREASURY_ENABLED` | `true` | feature flag — section stays hidden without this even if both addresses above are set (`web/lib/contracts.ts`) |

Leave `NEXT_PUBLIC_OPEN_TREASURY_ENABLED` unset (or anything other than
exactly `"true"`) to deploy the frontend with the section built but hidden,
if you want a gap between contract deploy and public launch.

## 5. Post-deploy checklist

Run these in order, on mainnet, with real (small) amounts:

1. **One small real deposit.** Pick an already-listed asset (e.g. SGOV), call
   `OpenTreasuryVaultFactory.getOrCreateVault(token)` for a real gen-4 token,
   confirm the returned address matches `vaultFor(token)` predicted
   beforehand, then `OpenTreasuryVault.deposit(asset, amount)` with a dust-
   above-minimum amount. Confirm `principal(you, asset)` reads back correctly
   and the token page's "Community deposits — withdrawable" figure updates.
2. **One `notifyReward`.** As that token's creator: `BallastHook.claim()` to
   pull your WETH share (or use any small WETH balance), `approve` the vault,
   call `notifyReward(amount)`. Confirm `periodFinish`/`rewardRate` update and
   the token page's reward-stream status shows "Current stream: ~7d
   remaining."
3. **One `claim`.** After rewards have streamed for a few minutes, call
   `claim()` from the depositor used in step 1. Confirm WETH actually lands
   in that wallet and `earned()` drops to (near) zero afterward.
4. **One withdrawal after the holding time.** Wait the full 24h minHoldTime
   (or redeploy a throwaway test vault on testnet with a short
   `minHoldTime` override via `OPEN_TREASURY_MIN_HOLD_TIME` first, if you want
   to confirm the mechanics faster before committing to the 24h mainnet
   wait). Confirm `withdraw(asset, amount)` succeeds and principal is
   returned.
5. **Token page check.** Load the real token's page with
   `NEXT_PUBLIC_OPEN_TREASURY_ENABLED=true`, confirm: the three figures (rule
   18) render distinctly, the deposit/withdraw/claim flows all work from a
   real wallet, the confirm-screen checkbox text matches exactly, APR shows
   "Unknown" until there's at least one real `RewardAdded` event in the
   trailing window, and delisted/unpriced assets (if you test with one)
   render honestly rather than silently.

## 6. Local commits

This work was committed locally in logical commits (contracts, tests,
frontend, docs — see `git log`). **Nothing has been pushed.** Push and
force-push are both explicitly out of scope for this task; only you decide
when and whether to push.
