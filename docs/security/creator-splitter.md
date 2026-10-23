# Creator team-splitter — design & security

An add-on that receives ONLY a token's **creator bucket** and fans it out to up to
4 fixed recipients. The buyback / stakers / parent-burn / treasury buckets keep
their existing security model untouched — the splitter only ever sees the
creator's own share.

- `contracts/src/CreatorSplitter.sol` — the immutable, ownerless splitter.
- `contracts/src/CreatorSplitterFactory.sol` — deploys splitters, marks them.

## Design

- **Immutable recipients + shares.** Set once in the constructor: 1–4 recipients,
  bps shares summing to 10,000, no zero address, no zero share, no duplicates. To
  change them you deploy a new splitter and repoint. No owner, no admin, no
  upgradeability.
- **Pull-based (OpenZeppelin PaymentSplitter accounting).** `releasable(token,
  recipient) = totalReceived(token) * share / 10000 − alreadyReleased`, where
  `totalReceived = currentBalance + totalReleased`. `release(token, recipient)`
  and `releaseAll(token)`; `token == address(0)` means native ETH, any other is an
  ERC-20 (WETH included). Because payouts are pull-based, a recipient that reverts
  on ETH receipt can never block the others — they just pull their own share.
- **Correct across many deposits.** The balance+released formula means repeated
  partial deposits and partial releases always reconcile to each recipient's exact
  cumulative share; it never double-counts or strands a recipient.

## Invariants & threats considered

- **No over-payment / bounded dust.** Integer division can leave up to
  `nRecipients − 1` wei of a token undistributed; that dust stays in the contract
  and is swept into a later deposit's distribution. Tested with a 3333/3333/3334
  split of an indivisible amount (`test_RoundingDustBounded`).
- **CEI + reentrancy guard.** `_released`/`_totalReleased` are updated before the
  external transfer, and `release`/`releaseAll` are `nonReentrant`. A reentrant ETH
  recipient cannot double-withdraw — on re-entry its `releasable` is already 0
  (`test_ReentrancyNoDoubleWithdraw`).
- **Non-standard ERC-20.** `SafeERC20` handles no-return-value tokens like USDT
  (`test_NoReturnErc20`). Fee-on-transfer tokens are handled correctly by the
  balance-based accounting (only what actually arrived is ever distributable).
- **Isolation.** One rejecting recipient doesn't block the rest
  (`test_RejectingRecipientDoesNotBlockOthers`).
- **No privileged address at all.** `release` is permissionless (anyone can poke
  it); funds only ever move to the fixed recipients.

16 unit tests, all green (adversarial-first per CLAUDE.md: constructor validation
and attack cases before happy paths).

## Integration with FeeRouter v2 — feasibility

FeeRouterV2 pays the creator bucket to an **immutable** `realCreator`:

- **`createAndLaunch` (fresh launch):** `realCreator = msg.sender`, immutable. A
  splitter **cannot** be installed as the creator payout target at launch without
  changing `FeeRouterFactoryV2`/`FeeRouterV2` — both on the frozen do-not-modify
  list. So automatic "set a team split at launch" is **not possible** without a
  core change (it would need a `creatorOverride` parameter threaded into the
  FeeRouterV2 constructor).
- **`createForExisting` (adopt path):** `realCreator` is a **parameter**. A creator
  adopting an existing token CAN pass a `CreatorSplitter` address as `realCreator`,
  so the whole creator bucket flows into the splitter with **no core change**.

**Conclusion / what ships:** the contracts + a flag-gated UI (`TeamSplitPanel`):
create a splitter, and view/release each recipient's share per asset. Using a
splitter as the creator payout address is supported where the address is settable
(the adopt path, and anywhere a creator can choose their own payout wallet). The
fresh-launch Create flow is **not** wired to auto-install a splitter, because the
frozen factory forces `realCreator = msg.sender`. Everything is hidden unless
`NEXT_PUBLIC_CREATOR_SPLITTER_FACTORY` is set.

## Remaining risks

- The limitation above is a product constraint, not a vulnerability: a creator who
  wants a launch-time team split on the fresh-launch path must either adopt after
  launch or wait for a future factory generation that accepts a creator-address
  override.
- The splitter has no mechanism to recover a wrong recipient (immutable by
  design). The UI must make the recipient/shares review explicit before signing.
