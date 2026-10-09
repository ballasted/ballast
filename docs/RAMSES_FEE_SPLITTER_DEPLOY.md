# Ramses fee-splitter stack — deploy order

Nothing in this stack has been deployed yet. This is the exact order and the
exact commands. Every script supports `DRY_RUN=true` — run that first, always.

No private key is ever read by these scripts or by Claude Code. Sign with
`--account <your-keystore> --sender <your-address>`.

---

## 0. Preconditions

- `RAMSES_LOCKER` is confirmed **not deployed anywhere** on Robinhood Chain as
  of 2026-10-09 (see the research report in the session this was built in —
  exhaustive on-chain + off-chain search, `.env.example`'s `RAMSES_LOCKER`
  comment summarizes it). Step 3 below deploys a fresh instance.
- **`RAMSES_VOTER` has no real value yet** — Ramses has not published a Voter
  for Robinhood Chain. Step 3's locker deploy is BLOCKED until you have one,
  or you deliberately accept that `collectRewards()` (gauge rewards) will
  never work for any position locked through it (voter is immutable —
  `collect()`, the swap-fee path, is unaffected either way). Do not deploy
  step 3 to mainnet with a placeholder voter address.
- `RAMSES_V3_POSITION_MANAGER=0x2eBd7B85a4E08D5B508b04BA147976C94afE6590` —
  verified (see `.env.example`). Re-verify yourself before broadcasting:
  ```
  cast call 0x2eBd7B85a4E08D5B508b04BA147976C94afE6590 "deployer()(address)" --rpc-url robinhood_mainnet
  # must print 0x4b37359BF291AbE8453692DB58d515a8b013Dca9
  ```

## 1. Dry-run everything first

```
DRY_RUN=true forge script script/DeployProtocolFeeSink.s.sol:DeployProtocolFeeSink \
  --rpc-url robinhood_mainnet --sender <your-address>
```

Prints the predicted `ProtocolFeeSink` and `BallastFeeSplitterFactory`
addresses (your sender's next two nonces, in that order). Confirm these look
right before broadcasting anything.

## 2. Deploy ProtocolFeeSink, then BallastFeeSplitterFactory

**Order matters.** The factory's `protocolRecipient` is an immutable
constructor argument — baked into every splitter it ever creates. The sink
must exist first.

```
forge script script/DeployProtocolFeeSink.s.sol:DeployProtocolFeeSink \
  --rpc-url robinhood_mainnet --account <your-keystore> --sender <your-address> --broadcast
```

Constructor args used (all fixed constants in the script, not env-driven):
- `ProtocolFeeSink(weth=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73, safe=0xEFC97e16a24d2434C7138a2634E554a0631aC079, registry=0x427764d0d19aB765c35A41A5aa4771580307dA81)`
- `BallastFeeSplitterFactory(protocolRecipient=<the sink just deployed>)`

The script prints both addresses and the exact `forge verify-contract`
commands (Sourcify) for each — run those next, then also run the Blockscout
verify command from a machine that isn't Cloudflare-blocked:

```
forge verify-contract <sink-address> src/ProtocolFeeSink.sol:ProtocolFeeSink \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663
forge verify-contract <factory-address> src/BallastFeeSplitterFactory.sol:BallastFeeSplitterFactory \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663
```

## 3. Deploy RamsesLocker (BLOCKED on a real Voter)

No script exists for this yet — write one once you have a real `RAMSES_VOTER`.
It is a two-argument constructor, nothing else to decide:

```solidity
new RamsesLocker(0x2eBd7B85a4E08D5B508b04BA147976C94afE6590, <RAMSES_VOTER>)
```

Verify after deploying:
```
forge verify-contract <locker-address> \
  lib/ramses-v3-contracts/contracts/RamsesLocker.sol:RamsesLocker \
  --verifier sourcify --chain-id 4663
```

## 4. Deploy RamsesLockLauncher

Needs the real locker (step 3) and the factory (step 2):

```solidity
new RamsesLockLauncher(0x2eBd7B85a4E08D5B508b04BA147976C94afE6590, <locker-address>, <factory-address>)
```

## 5. Set env vars (after every address above is deployed + verified)

```
RAMSES_V3_POSITION_MANAGER=0x2eBd7B85a4E08D5B508b04BA147976C94afE6590
RAMSES_VOTER=<the real one>
RAMSES_LOCKER=<step 3 address>
```

(No `NEXT_PUBLIC_*` vars needed yet — nothing in the frontend reads this
stack. Per the rules on this work: do not name "Ramses" or "the locker" in
any public-facing copy or UI yet.)

## 6. Per-launch: use the launcher, never call `lock()` directly

`RamsesLockLauncher.createAndLock(legs, launchedToken, creatorRecipient, creatorBps, protocolBps, expectedSqrtPriceX96, maxPriceDeviationBps)`
mints the position, deploys a fresh `BallastFeeSplitter`, and locks the
position to it, atomically. This is the ONLY path the position's NFT should
ever take into the locker — see `RamsesLockLauncher.sol`'s own docs for why.

`expectedSqrtPriceX96`/`maxPriceDeviationBps` close a front-running window: a
Ramses pool's genesis price can be set by anyone via the position manager's
permissionless pool-init path. The launcher creates/initializes the pool
itself at `expectedSqrtPriceX96` when it doesn't exist yet (atomically, so
nothing can beat it there), or verifies an already-initialized pool's live
price is within `maxPriceDeviationBps` (capped at `MAX_PRICE_DEVIATION_BPS`,
2000 = 20%) before minting into it — reverting rather than locking liquidity
into a price it never agreed to. See `RamsesLockLauncher._ensurePoolPrice`.
