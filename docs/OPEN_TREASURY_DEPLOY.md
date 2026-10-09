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
- A Foundry keystore for that wallet: `cast wallet new ~/.foundry/keystores opentreasury-deployer`
  (prompts for a password interactively — Claude Code never sees or handles
  it; this writes a NEW keystore and prints its address, no private key to
  import from anywhere else).
- The wallet funded with a small amount of ETH for gas (see §3 for the
  estimate once a dry-run has actually run).
- `RH_RPC_URL_PAID` (or any working mainnet RPC) set in your own shell — never
  pasted into chat, never committed.
- **Never use `--password-file`** for the broadcast step — that puts the
  keystore password in a file this process (or anything else on the machine)
  could read. Use `--account <keystore> --sender <address>` and type the
  password at the interactive prompt when `forge` asks for it.

## 2. Exact commands, in order

**Step 1 — dry run (no `--broadcast`), confirm predicted addresses:**
```bash
DRY_RUN=true forge script script/DeployOpenTreasury.s.sol:DeployOpenTreasury \
  --rpc-url "$RH_RPC_URL_PAID" --sender <your-address>
```
Prints the predicted `OpenTreasuryVaultFactory`, `OpenTreasuryVault`
implementation, and `OpenTreasuryLens` addresses (does not broadcast). Confirm
these look right, then run WITHOUT `DRY_RUN` and WITHOUT `--broadcast` to get
a real gas estimate from forge's own simulation:
```bash
forge script script/DeployOpenTreasury.s.sol:DeployOpenTreasury \
  --rpc-url "$RH_RPC_URL_PAID" --sender <your-address>
```
See §3 for why this sandbox could not run either of these itself this round.

**Step 2 — broadcast, signed by the keystore (you type the password):**
```bash
forge script script/DeployOpenTreasury.s.sol:DeployOpenTreasury \
  --rpc-url "$RH_RPC_URL_PAID" \
  --account opentreasury-deployer \
  --sender <your-address> \
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
  --constructor-args $(cast abi-encode "constructor(address)" 0x73ac3574c8743553f41c6e25f92a145b5c0e7240)
```
`0x73ac3574c8743553f41c6e25f92a145b5c0e7240` is the **current, live**
BackingLens — confirmed 2026-10-09 by reading it directly out of production's
own JS bundle (`NEXT_PUBLIC_LENS_ADDRESS` is a public env var, shipped to
every browser). The older `0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770` (still
referenced in `docs/BALLAST_STATE.md`/`docs/codex-indexing-form.md`, both
stale as of this redeploy) was superseded 2026-07-30 per `docs/ENV-AUDIT.md`
— using it here would have wired `OpenTreasuryLens` to a dead reference.

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

## 3. Dry-run — confirmed live against mainnet 2026-10-09

The public RPC (`https://rpc.mainnet.chain.robinhood.com`) was reachable this
session (a prior session's TLS error was specific to that sandbox run, not
the chain). Ran both the `DRY_RUN=true` address-prediction path and a plain
`forge script` simulation (no `--broadcast`) with a placeholder sender
(`0x000...dEaD`) — real numbers, real chain state, nothing broadcast:

```
Estimated gas price: 0.042532001 gwei
Estimated total gas used for script: 3,562,114
Estimated amount required: 0.000151503836210114 ETH
```

That's the real cost on real mainnet gas pricing right now — fund the deploy
wallet with a healthy margin anyway (gas price moves): **0.01 ETH is ~66x the
estimate and plenty.**

Predicted addresses from that same run are **illustrative only** — they're
computed from the placeholder sender's nonce, not your real keystore's. Once
you've created your keystore (§1) and have its address, give it to me and
I'll re-run `DRY_RUN=true` with your real `--sender` to get the actual
predicted `OpenTreasuryVaultFactory`/`OpenTreasuryVault` implementation/
`OpenTreasuryLens` addresses before you broadcast anything.

Also confirmed in this run: the script compiles cleanly, and the address
ordering is factory (sender tx 1) → implementation (factory's own internal
`new`, factory's nonce 1, NOT a sender-nonce tx) → lens (sender tx 2) — the
script's dry-run output computes all three correctly with that ordering.

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
