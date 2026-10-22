# Ownership migration — off the compromised EOA + a timelock on gen-4 FeeConfig

Prepared, NOT executed. Live `owner()` reads on chain 4663 (this review):

| Contract | Address | `owner()` | Base |
|---|---|---|---|
| **AssetRegistry** | `0x427764d0d19aB765c35A41A5aa4771580307dA81` | **old EOA `0xA277…37D1`** ⚠️ | Ownable2Step |
| **BuybackBurner v1** | `0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be` | **old EOA `0xA277…37D1`** ⚠️ | Ownable2Step |
| **BallastManatee** | `0xfd3534f2a6ca756e95e5d2ff7bd287954b856e4b` | **old EOA `0xA277…37D1`** ⚠️ | Ownable2Step |
| **FeeConfig gen-1** | `0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304` | **old EOA `0xA277…37D1`** ⚠️ | Ownable2Step |
| **FeeConfig gen-2/3** | `0xc0b895bc683bf4aca30c7277d42d068e0973a594` | **old EOA `0xA277…37D1`** ⚠️ | Ownable2Step |
| FeeConfig gen-4 | `0xE09F093595045E8765F420Cb12E0AA250910E5AD` | Safe `0xEFC9…C079` ✅ | Ownable2Step |

**Five of six core-control contracts are still owned by the compromised EOA.** The
most urgent is **AssetRegistry** — it is the asset allowlist every valuation and
routing path trusts (BackingLens, BasketZap, and the new RoundupRouter/BurnVote).
An attacker who controls that key could allowlist an impostor asset.

Safe (destination owner): `0xEFC97e16a24d2434C7138a2634E554a0631aC079`.

## Why two steps (all five are Ownable2Step)

`transferOwnership(new)` only sets a **pending** owner; the new owner must then
call `acceptOwnership()`. So nothing moves until the Safe accepts — and a
mis-typed destination can't brick the contract (the current owner stays until
acceptance).

1. **From the old EOA:** `transferOwnership(SAFE)` on each of the five contracts.
   These are signed by the EOA, so the broadcast commands live in the chat report,
   not here. (The key is compromised — do this from a clean session and watch the
   mempool; if an attacker front-runs a competing `transferOwnership`, the later
   call wins since it's single-owner, so broadcast all five close together.)
2. **From the Safe:** one batched `acceptOwnership()` across all five —
   `docs/safe-tx/accept-ownership.json`, loaded in Safe Transaction Builder.

After step 2, re-read `owner()` on all five → must be the Safe.

## gen-4 FeeConfig → TimelockController (the one already on the Safe)

gen-4 FeeConfig is the live fee brain: the gen-4 hook reads it **on every swap**
(`BallastHook.sol:284` for `feeBps()/BPS()`, `:322-324` for `feeParams()/
effectiveReferrer()/BPS()` — no caching). Its owner-only setters are
`setParams(feeBps,creatorBps,platformBps,referrerBps)` (`FeeConfig.sol:55`),
`setPlatformVault` (`:68`), `setReferrer` (`:74`); fee is hard-capped at
`MAX_FEE_BPS = 1_000` = 10% (`:21`, enforced `:59`). So the Safe can change the
fee/split instantly today — within the 10% cap, but with no public delay.

**Plan (reuse `contracts/script/DeployTimelock.s.sol`, per docs/PROTOCOL_CONTROLS.md):**

1. **Deploy** a `TimelockController` with `minDelay` in the 48h–7d range (the
   script defaults to 7 days via `MIN_DELAY_SECONDS`; 48h is the floor the task
   allows), the **Safe as BOTH proposer and executor**, and the deploy-time admin
   **renounced** (so only the timelock's own delayed process can change roles).
   *Note:* the script as written reads `DEPLOYER_PRIVATE_KEY`; run it instead with
   `--account <keystore> --sender <addr>` and drop that env var, per the no-private-
   key rule. (A one-line edit to swap `vm.envUint("DEPLOYER_PRIVATE_KEY")` +
   `vm.startBroadcast(pk)` for a bare `vm.startBroadcast()` is recommended.)
2. **Transfer** gen-4 FeeConfig ownership Safe → Timelock. Ownable2Step again:
   - Safe: `FeeConfig.transferOwnership(timelock)`.
   - Timelock accepts via a **scheduled proposal**: the Safe `schedule`s a call to
     `FeeConfig.acceptOwnership()` (delay = minDelay), waits, then `execute`s it.
3. **Thereafter** every fee/split change is `schedule` → wait `minDelay` → `execute`
   through the timelock, so any change is publicly visible for 48h–7d before it
   can take effect. The 10% `MAX_FEE_BPS` cap still applies on top.

The exact `schedule`/`execute` calldata depends on the deployed timelock address,
so it's generated after step 1; `docs/PROTOCOL_CONTROLS.md` holds the canonical
description of the control model.

## Order

1. Broadcast the five `transferOwnership(SAFE)` from the old EOA (chat report).
2. Execute `docs/safe-tx/accept-ownership.json` from the Safe; verify `owner()`.
3. (Separately, lower urgency) deploy the timelock and move gen-4 FeeConfig behind
   it. The other five FeeConfig-style contracts can follow the same timelock later
   if you want delays on them too; the immediate priority is getting them off the
   compromised EOA (steps 1–2).
