# Elysium protocol-fee burn design

**Decision owner: the human.** This doc frames the `protocolBurnDestination` choice so it is
made deliberately, not defaulted. It is referenced from `src/elysium/ProtocolFeeVault.sol`.

## What is fixed in code

`ProtocolFeeVault` accrues the protocol 20% of every gen-5 swap fee (credited by
`BallastHookV5` in the pool's quote asset — WHYPE on Elysium). It can move those funds to
**exactly one address**, `destination`, burned in at construction and **never changeable**.
There is no owner, no admin, no upgrade path, and no rescue. Both entrypoints (`collect`,
`forward`, and the `sweep` convenience) are permissionless and pull-based — safe precisely
because the funds have exactly one possible exit.

The contract deliberately encodes nothing about *what* that destination does. That is this
decision.

## What you must decide: where `destination` points

The protocol cut is in **WHYPE on Elysium**. The gen-1..4 model burned the protocol cut via
`BuybackBurnerV2` on Robinhood Chain. On Elysium at launch there is no equivalent wired, and
the vault is immutable, so pick the destination you can commit to permanently. Options:

1. **A holding address you control (simplest for launch).** A Safe or EOA that accrues WHYPE
   until a burn/buyback mechanism is chosen. Honest and reversible-in-intent, but the vault
   itself gives no on-chain guarantee of what happens next — so describe it to users exactly
   as "protocol fees accrue to <address>," never as "burned."

2. **A one-way burn sink.** A `0x…dEaD`-style address or a minimal burn contract, if the
   intent is to remove the WHYPE (or a token swapped from it) from supply. Only choose this
   if "burn" is the real, final intent — it is irreversible.

3. **A bridge endpoint → BuybackBurnerV2 on another chain.** If the protocol cut should fund
   the existing cross-chain buyback/burn, `destination` is the bridge's deposit address wired
   to deliver to `BuybackBurnerV2`. This needs the bridge verified and the delivery path
   tested end-to-end **before** deploy, because the vault address is immutable.

## Copy constraints (CLAUDE.md hard rules still apply)

However this is described in UI/docs: no "yield", "returns", "floor", "guaranteed", etc.;
never imply holders can claim or redeem these funds; the protocol fee is on **swaps**, never
on treasury deposits (there is no treasury on Elysium). Describe the destination by what the
contract actually guarantees: "funds can only ever go to <destination>."

## Recommendation for the Nov 9 launch

If the bridge→BuybackBurnerV2 path is not fully tested in time, launch with **option 1** (a
Safe you control) and describe it plainly as fee accrual, not burning. A future chain with a
local buyback can point a *new* vault's destination appropriately — the immutable vault means
"upgrading" is "deploy a new vault," which is fine since it sits downstream of the hook's
`setProtocolVault` wiring. Do not ship option 2 or 3 unless that path is verified, because it
cannot be undone.
