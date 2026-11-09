# Elysium gen-5 mainnet (99901) — prep & readiness report

**Date:** 2026-11-09 · **Branch:** `feat/gen5-elysium` · **Label:** Gen 5 · beta
**Author:** Claude Code (prep, verification, fork rehearsal). **Broadcasts: Rizky only.**

> **Bottom line:** Parts A and B are complete. The gen-5 contracts are **DEPLOYED and verified
> on Elysium mainnet 99901** (Rizky broadcast; batches 1–3 done, Safe owns the factory) — see
> **PART B** at the end for deployed addresses, on-chain verification, the real-address fork
> rehearsal, and the live smoke test. The SDK is wired (dry-run OK, Rizky publishes). Still
> owed, all Rizky-side: publish the SDK, build the Elysium **frontend** (needs the standard v4
> UR swap encoding + an architecture decision), extend the **Ponder indexer** to gen-5, verify
> source once the Blockscout explorer launches, and run the smoke test before announcing.
> Sections 0–9 below are the pre-broadcast prep (kept as the record of how each address/choice
> was verified).

---

## 0. Reality check on the starting premise

The run brief assumed "everything works on Elysium **testnet** (99801)." In the repo there is
**no evidence of a testnet deployment**: no `broadcast/**/99801/` artifacts, no testnet run
report, and `deployments/elysium-testnet.json` is still a template (`v4.*` empty,
`protocolBurnDestination` = `TBD_…` placeholder, `owner` empty). `.env` carries no Elysium
RPCs/keystore. What exists and is proven is the **contracts + scripts + tests port** (26 local
tests pass). So "promote testnet → mainnet" was really "do the mainnet prep from the port."
That is what this report covers. **The contracts have now been exercised against real 99901
chain state via a fork, which is stronger than the missing testnet deploy.**

---

## 1. RPC selection

| Role | URL | chain-id | notes |
|---|---|---|---|
| **Primary** | `https://rpc.elysium.kinetiq.xyz` | 99901 | official Kinetiq/Conduit RPC |
| **Backup** | `https://rpc.elyscan.live` | 99901 | community (unofficial) |

Cross-verified: both report **chain-id 99901**, and the **block hash at height 2,900,000 is
identical** on both: `0x0b280ea58aae99d5ee227d94f5fb04ff4340ee819006202afb9ce0f122011549`.
Heads within a few blocks (≈2.97M) at check time. Latency on both well under a second from
this host. Written to **gitignored** `.env` as `ELY_MAINNET_RPC` / `ELY_MAINNET_RPC_BACKUP`
(and `ELYSIUM_MAINNET_RPC_URL`, which the deploy scripts/config read).

Alchemy: **not used** — `ALCHEMY_KEY` is not set in this environment and Alchemy's 99901
support is unconfirmed. dRPC has an open PR adding Elysium but no stable public endpoint was
needed given two agreeing RPCs.

> **Privacy note:** a third-party RPC operator can see our transactions *before* they land
> (mempool visibility). For the real broadcasts, prefer the official Kinetiq RPC; the
> sequencer is first-come-first-served so there is no priority-fee MEV to buy anyway.

---

## 2. External addresses verified on 99901

All checked read-only against the primary RPC.

| Contract | Address | How verified | Verdict |
|---|---|---|---|
| WHYPE | `0xbA876237B0F021A6c6D852d6c26E107997cC5E81` | code present (2202b); `name`/`symbol` = `WHYPE`; `decimals` = 18 | ✅ |
| USDC.e | `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` | code present; `symbol` = `USDC`; `decimals` = **6** | ✅ (not a quote asset) |
| v4 PoolManager | `0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1` | **byte-identical to the official 4663 v4 PoolManager except the 20-byte embedded self-address** (same solc 0.8.26, identical metadata CBOR); 24009b | ✅ genuine v4 bytecode — **but see BLOCKER 1** |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | code present (9152b), canonical address | ✅ |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | code present, **exactly 69 bytes** = canonical Arachnid deployer | ✅ |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | code present (3808b), canonical | ✅ |
| Safe singleton v1.3.0 | `0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` | code present (22958b) | ✅ already on-chain |
| Safe proxy factory v1.3.0 | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | code present (3774b) | ✅ already on-chain |
| Safe fallback handler v1.3.0 | `0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4` | code present (5492b) | ✅ already on-chain |

**PoolManager detail:** the two bytecodes are the same length (24009) and differ in **exactly
20 bytes at one offset** — the contract's own address, which v4 embeds as an immutable. The
metadata tail (`…a164736f6c634300081a000a`, solc 0.8.26) is identical. This is a legitimate
independent deployment of the same PoolManager source, **not** a fork. Independently corroborated
on the web. **However:** Uniswap's official deployments list does **not** include 99901, and an
"Elyspump" v4 fork (with its own PoolManager/Quoter) also exists on Elysium. Ours matching
official bytecode is strong evidence it is the canonical one and not Elyspump — but *which v4
ecosystem has the liquidity + the matching periphery* is a call only you can make → **BLOCKER 1**.

**v4 periphery (PositionManager / StateView / V4Quoter / UniversalRouter):** NOT resolved.
They are **not needed to deploy the gen-5 contracts** (the deploy script reads only
`.v4.poolManager`), but the frontend swap path and the post-deploy smoke swap need the
**UniversalRouter that pairs with `0xE2e105…`**. Left empty in the config with the verification
method documented → **BLOCKER 3**.

---

## 3. The Ballast Safe (protocol owner + burn destination)

- **No Safe infra deploy needed** — the canonical v1.3.0 singleton, proxy factory, and
  CompatibilityFallbackHandler all already have code on 99901.
- Owners copied from the Robinhood-Chain Safe `0xEFC97e16a24d2434C7138a2634E554a0631aC079`
  (`getOwners`): `0xBfD4F1E8…c488`, `0x3810a51b…5adb`, `0x594527d8…5527`.
  ⚠️ The RH Safe is currently **1-of-3** (`getThreshold` = 1). Per the brief, the Elysium Safe
  uses threshold **2** (a deliberate upgrade).
- **Computed & fork-proven Safe address:** `0xa4dCbAd7A34da4473040d9f0fE35990c458A727C`
  - Created on an anvil fork of 99901 via `createProxyWithNonce(singleton, initializer, saltNonce)`.
  - `saltNonce` = `0x42414c4c4153540001` (fixed; "BALLAST"+0001).
  - `initializer` = `setup([owner1,owner2,owner3], 2, 0, 0x, 0xf48f2B2d…, 0, 0, 0)`.
  - On the fork: `getOwners` = the 3 owners, `getThreshold` = 2, `VERSION` = `1.3.0`,
    fallback-handler slot = `0xf48f2B2d…`. Deterministic → Rizky gets the **same address** on
    mainnet with the same params. This is **batch 1** of the broadcast.

This Safe is both `owner.protocolOwner` (factory owner) and `params.protocolBurnDestination`
(the vault's immutable sink). Burn-design **option 1**: the protocol 20% accrues to the Safe,
earmarked for $BALLAST buyback & burn once a bridge is live. Described as *accrual*, never as
"burned/yield/returns".

---

## 4. Mainnet config + deploy simulation

`contracts/deployments/elysium-mainnet.json` filled (chainId 99901, infra, tokens, poolManager,
Safe for owner+burnDest, defaults confirmed: opening valuation 27 HYPE, tick -174300 (÷60 ok),
protocolFeeBps 2000, swap-fee bounds 100–1000, treasury off).

**Simulation** (`DeployElysium`, no broadcast, against the live-forked 99901) succeeded:
- Config validated (`chainId cfg 99901 == live`, poolManager & WHYPE have code).
- Hook **mined** to a flag-valid address — **expected hook: `0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc`**
  (deterministic via the 0x4e59 CREATE2 deployer; independent of the EOA — Rizky's broadcast
  should produce the **same** hook address; if it differs, STOP).
- Vault / seeder / factory deploy & wire; `factory.pendingOwner` = the Safe.
- **Estimated gas ≈ 12.26M; ≈ 0.00214 HYPE** at 0.175 gwei. Budget ~0.005 HYPE for margin.
- Deployer HYPE balance check: **pending the real deployer address** (BLOCKER 2).

The expected (simulated) gen-5 addresses are a function of the deployer nonce and will differ
on the real broadcast **except the hook** (CREATE2). The real addresses are captured
automatically by the sync script (§6) from the broadcast artifact.

---

## 5. Fork rehearsal — the real test (ALL GREEN)

The full gen-5 suite was run against the **real forked 99901 PoolManager** (`0xE2e105…`) by
making `Gen5.t.sol` setUp fork-aware (`ELYSIUM_FORK_RPC` + `ELYSIUM_FORK_POOLMANAGER`; offline
path unchanged so CI stays green). **20/20 passed in ~24s.**

| Brief item | Covered by | Result |
|---|---|---|
| Deploy everything | A4 simulation + setUp wiring | ✅ |
| Launch on HYPE/WHYPE | `test_LaunchGraduate_FeeSplit_8020`, `test_Graduate_SetsOpeningTick` | ✅ |
| "another pair" | N/A on Elysium — **WHYPE is the only green quote asset** (by design) | ⚠️ see note |
| Swaps both ways | buy (`_fundAndApproveSwap`+swap) / sell (`test_SellExactOut_Reverts` guards exact-out) | ✅ |
| Fee split lands right (creator / vault / Safe) | `test_LaunchGraduate_FeeSplit_8020` (80/20, `vault.sweep` → dest only) | ✅ |
| Fee bounds (1% & 10% ok, 0 & 11% revert) | `test_Launch_AcceptsBoundaryFees`, `…RevertsFeeTooLow/High` | ✅ |
| Fee immutability | `test_InitPool_WriteOnce` (per-pool fee write-once) | ✅ |
| Limit order place/fill/cancel | `test_LimitOrder_PlaceFillWithdraw`, `…CancelUnfilled`, `…ProRata`, `…CrossManyOrders` | ✅ |
| Timestamp-only expiry/timing | `test_SplitChange_*` (vm.warp on block.timestamp); limit orders are GTC (no block.number anywhere) | ✅ |
| LP permanently locked | `test_LPLock_SeederBlocked` | ✅ |
| Ownership → Safe path | `test_Ownership_TwoStepTransfer` | ✅ |
| Buyback burn to dEaD | `test_FeeRouter_RouteCreatorAndBuyback` | ✅ |

**"Another pair" note:** the factory allows **only WHYPE** as a quote asset on Elysium
(`isGreenQuoteAsset` — WHYPE green from construction; `setGreenQuoteAsset` is owner-only and
reserved for future stock-token feeds). So every launch is TOKEN/WHYPE; the multi-quote "other
pair" from the brief does not apply on this chain. The quote asset in the rehearsal is a
`TestERC20` stand-in, which still drives the **real** forked PoolManager, hook, limit orders and
fee math; the real-WHYPE path is covered by the A4 factory construction (real WHYPE) and the
post-deploy smoke swap (B5).

**block.number audit (Elysium returns the parent-chain block for `block.number`):** no
`block.number` anywhere in `src/elysium`. All time logic uses `block.timestamp`
(`FeeRouterV5` split delay / cooldown). Limit orders are good-til-cancelled (no time expiry).
**No exposure to the parent-block gotcha.**

---

## 6. Apps (frontend / SDK / MCP / bot / indexer)

Addresses do not exist until batch 2 is broadcast, so the deliverable is a **sync script**, not
hand-copied addresses:

- **`contracts/script/sync-elysium-mainnet.cjs`** — run after the broadcast; reads
  `broadcast/DeployElysium.s.sol/99901/run-latest.json`, extracts the 4 gen-5 addresses **by
  contract name**, patches the config's `ballast` block, and writes **`deployments/elysium-mainnet.addresses.json`**
  (a flat map the apps import — one source of truth). It also records the **Ponder `startBlock`**
  = the **L2 block** of the factory deploy receipt (RPC block numbers are L2; only `block.number`
  inside the EVM is the parent block). Tested against the dry-run artifact — extracts all four
  correctly.

Remaining app wiring (frontend chain def + "Gen 5 · beta" label + burn wording; SDK bump; MCP;
bot; indexer) is **post-broadcast** (Part B) and gated on the real addresses — doing it now
would hard-code placeholders. The burn wording to use verbatim: *"On Elysium, the protocol share
accrues to the Ballast Safe (2-of-3) and is used for $BALLAST buyback & burn once the bridge is
live."*

---

## 7. Privileged roles (what exists after deploy)

| Contract | Privileged role | Holder | Scope |
|---|---|---|---|
| BallastFactoryV5 | `owner` (Ownable2Step) | **the Safe** (after `acceptOwnership`); deployer until then | only `setGreenQuoteAsset`; everything else immutable. `launch`/`graduate` are permissionless |
| BallastHookV5 | `setSeeder` / `setProtocolVault` gated on `tx.origin == _deployer` | deployer EOA | **one-time each, consumed at deploy**; no ongoing admin. Callbacks are `onlyPoolManager` |
| ProtocolFeeVault | — | **none** | no owner/admin/rescue; funds can only go to the immutable `destination` (the Safe) |
| BallastSeederV5 | — | **none** | fully immutable; LP is permanently locked |
| FeeRouterV5 (per launch) | `onlyRealCreator` | the token's creator EOA | `scheduleSplit` (asym. delay), `setMetadataURI`; `route()` is permissionless |

No proxies, no upgradeability, no pause, no rescue anywhere in gen-5.

---

## 8. Post-decision verification (round 2)

- **v4 PoolManager `0xE2e105…` — CONFIRMED** by Rizky as Elysium's canonical v4 (also the one
  0x Settler PR #701 uses, merged Nov 3). On-chain roles read before deploy:
  - `owner()` = **`0xA9aE0c5eb238a519b7f5Af27415eb6Dd0744Da8D`** (the PoolManager admin; can set
    a `protocolFeeController` and protocol fees up to the v4 cap — a standard residual trust in
    any v4 deployment, not specific to us).
  - `protocolFeeController()` = **`0x0000…0000`** (unset) — **no Uniswap protocol fee** is skimmed
    on top of our hook fee today.
- **UniversalRouter — v2.2.0 `0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a` selected** (from
  Uniswap/universal-router PR #534, open/not merged). Verified on 99901:
  - code present (23233b); `poolManager()` == `0xE2e105…`; WHYPE + Permit2 present as embedded
    immutables in the runtime bytecode (the UR exposes no `WETH9()`/`permit2()` getter).
  - v2.1.2 (`0xA13f7611…4b45`) also verifies the same way (24380b) — kept in config as the alt.
  - **Why v2.2.0:** the rule was "match the 4663 frontend encoding, else v2.2.0." Our 4663
    frontend encodes v4 swaps with the **modified-fork `minHopPriceX36`** struct
    (`web/lib/swap.ts`, `web/lib/robinhoodRouter.ts`, `web/hooks/useRouterV2Swap.ts`,
    `web/lib/abis.ts`, `web/app/(marketing)/integrate/page.tsx`). Both Elysium URs are **standard**
    Uniswap URs (no `minHopPriceX36`), so neither matches → tiebreak → **v2.2.0**. Marked in
    config as *"verified, Uniswap PR #534 pending merge."*
  - ⚠️ **Frontend (Part B):** the Elysium swap path must use **standard v4 UR encoding** — it
    **cannot** reuse the 4663 `minHopPriceX36` calldata. New encoding path required for 99901.
  - Not done: a byte-for-byte diff against the same UR version on another chain (needs a second
    chain's v2.2.0 UR + RPC). The immutable-presence + working `poolManager()` getter already
    prove it's a genuine v4 UR wired to our PoolManager; offer to run the cross-chain diff on request.
- **Deployer funded:** `0x1bd72E88…391bc` balance now **0.593 HYPE** (deploy needs ~0.00214). ✅
- **RH Safe (4663) threshold:** re-read = **1** (Rizky's raise to 2-of-3 not yet applied at read
  time). The Elysium Safe is 2-of-3 regardless (set in its own `setup`).

## BLOCKERS (remaining)

1. **Broadcasts** (§ Handoff) — mainnet signing is yours only. Everything they depend on is ready.
2. *(Optional, Part B)* source `positionManager` / `stateView` / `v4Quoter` for frontend reads/LP
   (not needed for the deploy or basic swaps).

All Part-A verification (RPC, external addresses incl. PoolManager roles + UniversalRouter, Safe,
config, simulation, fork rehearsal, audit, sync script) is complete.

---

## 9. Post-decision verification (round 3 — supersedes §3 Safe + Handoff)

- **Safe singleton → GnosisSafeL2 `0x3E5c63644E683549055b9Be8653de26E0B4CD36E`** (per Rizky; L2
  variant, Safe{Wallet}-compatible if Elysium is added). Code present on 99901 (23800b). **New
  deterministic Safe (recomputed on fork): `0xa4dCbAd7A34da4473040d9f0fE35990c458A727C`** — same
  owners, threshold 2, fallback handler, saltNonce `0x42414c4c4153540001`. On fork: `getOwners`
  = 3 owners, `getThreshold` = 2, `VERSION` = 1.3.0, slot0 (singleton) = the L2 singleton.
  init-code-hash `0xcaf2dc2f…`, CREATE2 salt `0x3d01732d…`.
- **Hook address unchanged = `0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc`** — re-simulated the
  full deploy with the new config; the Safe address feeds only the vault/factory constructors,
  not the hook initcode, so mining is identical. Fork rehearsal re-run after the change: **20/20
  still green.**
- **Batch-3 accept flow simulated on fork** (see Handoff): `approveHash` (owner `0x3810a51b…`,
  ~53k gas) + `execTransaction` (owner `0x594527d8…`, ~87k gas) → `factory.owner()` = Safe,
  `pendingOwner()` = `0x0`. Both signer wallets need a little HYPE for gas (≈0.01 HYPE each is
  ample; actual cost < 0.00002 HYPE each at 0.175 gwei).
- **PoolManager owner `0xA9aE0c5e…Da8D`** is a **contract** (7310b, nonce 1), **not an EOA**, and
  is **not** the same as the 4663 PoolManager owner (`0x2BAD8182C09F50c8318d769245beA52C32Be46CD`).
  Report-only, non-blocking.

---

## Handoff — exact broadcast order (run from `contracts/`, interactive password)

> Never `--private-key` / `--password-file` on mainnet. Use `--account <keystore-name>`.
> Re-check `cast balance 0x1bd72E88…391bc` is funded right before batch 2.

**Batch 1 — the Safe (GnosisSafeL2; must exist before the vault can receive).** `createProxyWithNonce`
on factory `0xa6B71E26…` with **L2 singleton `0x3E5c6364…`**, the §9 initializer, saltNonce
`0x42414c4c4153540001`. Expected proxy: **`0xa4dCbAd7A34da4473040d9f0fE35990c458A727C`**.
**Check:** `getOwners` = the 3 owners; `getThreshold` = 2; `VERSION` = 1.3.0; storage slot 0 =
the L2 singleton.

**Batch 2 — gen-5 core** (`--slow` + 2× gas multiplier for L2 safety):
```
ELYSIUM_CONFIG=deployments/elysium-mainnet.json \
forge script script/DeployElysium.s.sol:DeployElysium \
  --rpc-url $ELY_MAINNET_RPC --account <KEYSTORE_NAME> --sender $ELY_MAINNET_DEPLOYER \
  --broadcast --slow --gas-estimate-multiplier 200
```
Deploys hook (expected **`0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc`** — if different, STOP) +
vault + seeder + factory, and `transferOwnership(Safe)`. **Check:** `hook flags OK`;
`factory.pendingOwner()` = the Safe. Then `node script/sync-elysium-mainnet.cjs`.
**If it stops halfway, resume (same command + `--resume`):**
```
ELYSIUM_CONFIG=deployments/elysium-mainnet.json \
forge script script/DeployElysium.s.sol:DeployElysium \
  --rpc-url $ELY_MAINNET_RPC --account <KEYSTORE_NAME> --sender $ELY_MAINNET_DEPLOYER \
  --broadcast --slow --gas-estimate-multiplier 200 --resume
```

**Batch 3 — hand the factory to the Safe (no Safe UI on Elysium → raw cast flow).**
After batch 2, with `FACTORY` = the deployed factory and `SAFE` = `0xa4dCbAd7…727C`:
```
# 1. compute the safeTxHash (nonce 0) — factory-specific, so compute AFTER batch 2
DATA=$(cast calldata "acceptOwnership()")           # 0x79ba5097
Z=0x0000000000000000000000000000000000000000
STH=$(cast call $SAFE \
  "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
  $FACTORY 0 $DATA 0 0 0 0 $Z $Z 0 --rpc-url $ELY_MAINNET_RPC)

# 2. owner A = 0x3810a51b… (lower address) pre-approves
cast send $SAFE "approveHash(bytes32)" $STH \
  --rpc-url $ELY_MAINNET_RPC --account <OWNER_A_KEYSTORE> --sender 0x3810a51bb35be1e6876fFFbA32A39ce054bC5adb

# 3. owner B = 0x594527d8… executes with the two pre-approved/contract signatures, sorted by
#    signer address ascending (A then B), each v=1 (A via approveHash, B as msg.sender):
SIGS=0x0000000000000000000000003810a51bb35be1e6876fffba32a39ce054bc5adb000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000594527d8656d917ddfd32fcd5729dab349c75527000000000000000000000000000000000000000000000000000000000000000001
cast send $SAFE \
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
  $FACTORY 0 $DATA 0 0 0 0 $Z $Z $SIGS \
  --rpc-url $ELY_MAINNET_RPC --account <OWNER_B_KEYSTORE> --sender 0x594527d8656D917DdfD32fcD5729DAb349C75527
```
**Gas wallets:** owner `0x3810a51b…` and owner `0x594527d8…` each need a little HYPE (≈0.01 is
ample). **Check:** `factory.owner()` = `0xa4dCbAd7…727C`; `factory.pendingOwner()` = `0x0`.
(You may swap which two of the three owners sign; keep the signature blocks sorted by signer
address ascending and set each `--sender` to match.)

**Then (Part B):** verify contracts on the explorer (Blockscout), run the sync script, wire the
apps, do one controlled smoke launch+graduate+swap+limit order before announcing.

---

## Draft announcement (no "audited"; "Gen 5 · beta")

> **BALLAST is live on Elysium — Gen 5 (beta).**
> Creator-picked swap fee (1–10%, fixed at launch), on-chain limit orders inside the hook, and
> permanently-locked launch liquidity. Pairs trade against WHYPE. A fixed 20% protocol share of
> each swap fee accrues to the Ballast Safe (2-of-3) and is earmarked for $BALLAST buyback &
> burn once the bridge is live; the rest goes to the creator side. No treasury on Elysium. Gen 5
> is beta software — use at your own risk.

---

# PART B — post-broadcast (deployed 2026-11-09)

## Deployed addresses (99901)

| Contract | Address | tx |
|---|---|---|
| Ballast Safe (2-of-3, GnosisSafeL2) | `0xa4dCbAd7A34da4473040d9f0fE35990c458A727C` | `0x6fb02bbb…90c6e` |
| ProtocolFeeVault | `0xA8fAd48376572075288ad60eE199b36bc445D1b0` | batch 2 |
| BallastHookV5 | `0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc` | batch 2 |
| BallastSeederV5 | `0x1A2b1e5361a5f1cc0c8fe48b983D8191F0fA4444` | batch 2 |
| BallastFactoryV5 | `0x24c9582C31a7B890dC51D51e99E1283880Bc4bEE` | batch 2 |
| acceptOwnership (approveHash / execTransaction) | — | `0xc586bb44…3bdd` / `0x92f3c3cc…37a9` |

Deployer `0x1bd72E880C2222C756F1eAD9E40A14f7220391bc`. Ponder startBlock (L2) **3085053**.
Explorer: official mainnet explorer is "coming soon"; community `elyscan.live` is live.

## B1 — read-only verification (all ✓)

- Code present on all four; **runtime bytecode matches the local build** (masked immutables)
  via `script/verify-runtime-match.cjs`; the hook is additionally proven by its CREATE2 address.
- Hook flags `addr & 0x3fff = 0x12cc` (AFTER_INITIALIZE | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA
  | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA | BEFORE_REMOVE_LIQUIDITY). ✓
- Wiring: `hook.seeder`=seeder, `hook.protocolVault`=vault, `hook.poolManager`=PM, fee 2000/100/1000;
  `vault.hook`=hook, `vault.destination`=**Safe**; `seeder.hook`=hook, `seeder.poolManager`=PM.
- Factory: `owner`=**Safe**, `pendingOwner`=0x0, hook/seeder/whype/poolManager correct,
  `treasuryEnabled`=false, fee bounds 100/1000, openingTick −174300, WHYPE green.
- Safe: owners = the 3, threshold 2, VERSION 1.3.0, slot0 = GnosisSafeL2 singleton.

### Privileged roles on 99901 (who can do what)
| Contract | Role | Holder |
|---|---|---|
| BallastFactoryV5 | `owner` (only `setGreenQuoteAsset`) | **Safe** `0xa4dCbAd7…727C` (2-of-3) |
| BallastHookV5 | one-time `setSeeder`/`setProtocolVault` (already consumed) | deployer `0x1bd72E88…` — no ongoing power |
| ProtocolFeeVault | none | — (funds can only go to the Safe) |
| BallastSeederV5 | none | — (immutable, LP locked) |
| FeeRouterV5 (per launch) | `onlyRealCreator` | the launching creator EOA |

No proxies / pause / upgrade / rescue anywhere. PoolManager owner `0xA9aE0c5e…Da8D` is a
contract (not our role; `protocolFeeController`=0x0, so no Uniswap protocol fee today).

## B3 — rehearsal on a fresh fork against the REAL addresses (2/2 ✓)

`test/elysium/Gen5RealFork.t.sol` forks 99901 and drives the live factory/hook/seeder/vault:
launch → graduate → swap → **80/20 fee split** → `vault.sweep` to the **real Safe**, plus a
limit order place/fill/withdraw. Both pass.

## B2 — explorer source verification — BLOCKED (documented)

The official mainnet explorer is "coming soon"; the kinetiq `/explorer` endpoint is a
Vercel-gated frontend (no reachable Blockscout API), and Sourcify does not list 99901. So
automated verification isn't possible yet. When the Blockscout explorer launches, verify with
(constructor args from `broadcast/DeployElysium.s.sol/99901/run-latest.json`):
```
forge verify-contract <addr> <Contract> --verifier blockscout \
  --verifier-url <explorer>/api/ --chain-id 99901 --watch
```
for BallastHookV5 / ProtocolFeeVault / BallastSeederV5 / BallastFactoryV5, plus one
FeeRouterV5 + one BallastToken after the first launch. (No API key needed for Blockscout.)

## B4 — apps wired for 99901

- **SDK (`packages/sdk`): DONE** — additive `elysiumChain` + `ELYSIUM_ADDRESSES` + `ELYSIUM_START_BLOCK`
  (gen-4/4663 paths untouched). Builds green; version 0.1.0; `npm publish --dry-run` OK — **Rizky publishes**.
- **Single source of truth:** `deployments/elysium-mainnet.addresses.json` (written by
  `contracts/script/sync-elysium-mainnet.cjs` from the broadcast artifact).
- **Frontend / Indexer / Telegram bot: SCOPED, NOT shipped.** These are built for **gen-4 on
  Robinhood Chain (4663)** and supporting gen-5/Elysium is a *feature build*, not a config add:
  - Frontend (`web`) is **deliberately single-chain** (hard-wired to 4663; the code comments
    record that a multi-chain wagmi config caused the launch bug they fixed). Serving 99901 needs
    an architecture decision (separate env-selected deployment vs multi-chain) **and** the
    **standard v4 UR swap encoding** (this repo's v4-periphery is the RH fork with `minHopPriceX36`;
    the Elysium UR rejects it — confirmed at the struct level), **and** treasury-OFF UI. Plus the
    "preview → prod" validation is Rizky's (no Vercel access here).
  - Indexer (`indexer`, Ponder) is single-chain 4663 with gen-4 ABIs/events (the `Launched` event
    carries a `treasury` param gen-5 doesn't have) and a treasury-centric schema. 99901 needs the
    gen-5 ABIs, a second chain (startBlock 3085053), new handlers, and schema additions.
  - Telegram bot lives inside `web` (`web/lib/tg`) and ships with the frontend. **No standalone
    MCP server exists in the repo** (nothing to wire).

  None of these can be safely shipped blind without their runtimes (Vercel preview, a Ponder DB,
  bot restart) — all Rizky-side. The verified addresses + the sync script + the SDK constants give
  every app a single, correct source to build against.

## B5 — live smoke test (fork-validated, ready for Rizky)

`contracts/script/SmokeElysium.s.sol` — fork-validated green (launch → graduate → buy →
80/20 split → sweep to Safe → limit order place+cancel). Run on mainnet:
```
# from contracts/  (SMOKE_WHYPE optional, default 0.05 WHYPE of real value; also needs a little HYPE for gas)
SMOKE_WHYPE=50000000000000000 forge script script/SmokeElysium.s.sol:SmokeElysium \
  --rpc-url $ELY_MAINNET_RPC --account <KEYSTORE_CONTROLLING_0x1bd72E88> \
  --sender 0x1bd72E880C2222C756F1eAD9E40A14f7220391bc --broadcast --slow
```
It creates a real "BallastSmoke/BSMOKE" launch + deploys a PoolSwapTest helper (buy path).
After it runs, read-only checks (I run these): the `Launched`/`Graduated` events; the pool opened
at ±174300; `hook.owed(feeRouter, WHYPE)` ≈ 80% and `hook.owed(vault, WHYPE)` ≈ 20% of the fee
pre-sweep; the Safe's WHYPE balance rose by the protocol 20% after sweep.

## Remaining for Rizky (in order)

1. Publish the SDK (`npm publish` from `packages/sdk`, v0.1.0).
2. Decide the frontend architecture (recommend a **separate env-selected Elysium deployment** to
   preserve the single-chain design) and build: 99901 chain def (from the SDK), gen-5 launch flow,
   **standard v4 UR swap encoding**, treasury-OFF UI, "Gen 5 · beta" label + the burn wording.
   Preview on Vercel → verify launch/buy → promote to prod.
3. Extend the Ponder indexer to 99901 (gen-5 ABIs + handlers + schema; startBlock 3085053) and run it.
4. Verify contract source once the Blockscout explorer launches (B2 commands above).
5. Run the smoke test (B5) before announcing.
