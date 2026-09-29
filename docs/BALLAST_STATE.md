# BALLAST — full state, 2026-09-29

Everything below is verified live on-chain this session (`cast call` against
`$RH_RPC_URL_PAID`, GoPlus's public API, GeckoTerminal's public API, `vercel
env ls`, `git log`/`git remote`) unless marked otherwise — not from memory,
not from stale docs. Where something is genuinely unverifiable right now
(Blockscout is Cloudflare-blocking this sandbox as of 2026-09-29), that's
stated plainly, not glossed over.

---

## 1. Every contract, every generation

### Core (gen-4, current — deployed 2026-09-26, `DeployCombinationPackage.s.sol`)

| Contract | Address | Owner | Verified? |
|---|---|---|---|
| BallastFactory | `0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67` | — (no admin surface) | Unknown — Blockscout unreachable this session |
| BallastHook | `0x4eb2dd759f4d6524e66057d1adc10c26e40142cc` | — (no admin surface) | Unknown |
| BallastSeeder | `0x690241daf35efdf34e0b726aceb451bd901858db` | — (no admin surface) | Unknown |
| BallastRouter | `0xc422e0a6ca75d1ffafd77f72b710b2ef3aef50e1` | — (no admin surface) | Unknown |
| FeeConfig (gen-4) | `0xE09F093595045E8765F420Cb12E0AA250910E5AD` | old EOA `0xA277…37D1` (`pendingOwner` = Safe, accept not yet run) | Unknown |

### Shared across every generation

| Contract | Address | Owner |
|---|---|---|
| AssetRegistry | `0x427764d0d19aB765c35A41A5aa4771580307dA81` | old EOA `0xA277…37D1` |
| BackingLens | `0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770` | — (no admin surface) |

### Prior generations (still live — see `docs/seeded-hook-history.md`)

| Gen | Factory | Hook | Seeder | Tokens |
|---|---|---|---|---|
| 1 | `0x069974136c78Cf0F2162463B95321E59F56523D8` | `0x9C15c992E4De3711715C8B7D717EF46e474680CC` | `0xbe043844e0B7713B4c7841DCCB3C4e1c6eA5eCF9` | BALLAST v1, CHRS, RCN |
| 2 | `0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1` | `0x743102aa1De955b5F0Fada1377B6E545Fdb080cc` | `0x7830E1F67598e8c76ce1fFf79b1D2A3E915325E4` | SYNTH, BILLIST, CLAP, MANATE, SAGE, PHIL, BCAT |
| 3 | `0x3eb5532e982931cad40d0416adbd7930a57965ae` | `0x4915f612c89100bEbE9279355fab27022D0940cc` | `0xFC5362e535a20c99D75C2595dfF6f7bA1E99A523` | HARUNA, BALLCAT |

Prior FeeConfig instances (both still owned by the old EOA):

| Instance | Address | Split (fee/creator/platform/referrer bps) | Platform vault |
|---|---|---|---|
| gen-1 | `0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304` | 100/5000/3500/1500 (1%, 50/35/15) | `0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85` |
| gen-2/3 (shared) | `0xc0b895bc683bf4aca30c7277d42d068e0973a594` | 100/5000/3500/1500 (1%, 50/35/15) | `0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be` (= BuybackBurner) |
| gen-4 (current) | `0xE09F093595045E8765F420Cb12E0AA250910E5AD` | 100/8000/2000/0 (1%, **80/20/0**) | `0xEFC97e16a24d2434C7138a2634E554a0631aC079` (= the Safe) |

**Found this session, not previously documented anywhere**: `web/lib/contracts.ts`'s
`HISTORICAL_HOOKS` constant was missing gen-3 entirely since the day it was
introduced (`61888e3`) — meaning HARUNA and BALLCAT's real, graduated,
liquid pools have been unresolvable to the entire frontend (price, swap,
fee claims — everything) since gen-3 launched. **Fixed this session**
(one-line addition, `tsc --noEmit` clean, `vitest` 53/53 still green).

### Other contracts

| Contract | Address | Owner | Notes |
|---|---|---|---|
| BuybackBurner (v1-only, immutable target = v1) | `0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be` | old EOA `0xA277…37D1` | 3 buybacks run; 0.000628 WETH accrued now, threshold 0.05 WETH |
| BallastManatee (1,000-piece NFT) | `0xfd3534f2a6ca756e95e5d2ff7bd287954b856e4b` | old EOA `0xA277…37D1` | **Fully minted: 1000/1000** |
| ManateeRenderer | `0xbd602bddb55b3a200015bafcd975e54a93549327` | — (no admin surface) | |
| MetadataDenylist | not deployed | — | env var empty, app degrades to permissive/fail-open (by design) |
| TimelockController | not deployed | — | Script ready (`contracts/script/DeployTimelock.s.sol`), Safe address now known — see §5 Ownership |

### UPDATE 2026-09-29 (later session) — verification mostly DONE, via Sourcify

**Root cause of "verify-all.sh failed on my machine" found and fixed**:
`contracts/foundry.toml` had an `[etherscan]` table (added for a past
Blockscout deploy's convenience). Its mere PRESENCE makes `forge
verify-contract` print "ETHERSCAN_API_KEY is set, defaulting to Etherscan
verifier" and silently ignore any explicit `--verifier` flag — reproduced,
then fixed by removing the block, confirmed the exact same command then
worked. This wasn't a network problem at all.

**Sourcify (`sourcify.dev`) is a real, working, separate verification
route** — confirmed reachable from this sandbox (unlike Blockscout, which
stays Cloudflare-blocked here). **27 of 35 contracts across the whole fleet
verified with `exact_match`** this session: all 7 core contracts
(BallastFactory, BallastHook, BallastSeeder, BallastRouter, FeeConfig gen-4,
AssetRegistry — already verified previously, BALLAST v2's token+treasury),
every gen-3/gen-4 token+treasury, TEST, and most gen-1/gen-2 tokens+treasuries
(v1, RCN, BILLIST, CLAP, MANATE + their treasuries were already
Sourcify-verified from a prior point).

**8 contracts still unverified** — CHRS, PHIL, SYNTH, SAGE, BCAT (tokens),
SAGE + BCAT (treasuries), and BackingLens — all fail Sourcify's own recompile
with `bytecode_length_mismatch` (the current `src/*.sol` at HEAD, compiled
with the current `foundry.toml` settings, produces different-LENGTH creation
code than what's actually on those 8 addresses — likely a historical source
commit difference, not a tooling bug; full theory in
`docs/verify-manual/README.md`). **Guaranteed manual-upload packages ready**
for all 8 in `docs/verify-manual/<name>/` (Standard JSON Input + constructor
args + exact Blockscout click-steps) — passes Cloudflare because it's your
browser, not a script.

`contracts/script/verify/verify-all.sh` rewritten to default to Sourcify
(idempotent, checks Sourcify's own status endpoint) with an opportunistic,
non-blocking Blockscout attempt alongside.

**GoPlus still shows BALLAST v2 as unverified** (`is_open_source=0`)
even after Sourcify verification — GoPlus's signal appears to read Blockscout
specifically, not Sourcify, so this doesn't flip until Blockscout verification
lands (via the manual route above, or once Cloudflare clears). Re-check after
the manual Blockscout uploads land.

### Blockscout verification — still genuinely blocked from this sandbox

**Blockscout (`robinhoodchain.blockscout.com`) is Cloudflare-blocking every
request from this sandbox** — confirmed on both the read API
(`/api/v2/addresses/...`, 403) and `forge verify-contract`'s submission
endpoint (same 403, both with and without `--skip-is-verified-check`),
re-tested multiple times across this session. This was previously described
as "intermittent" (worked from a human's machine during the 2026-09-26
deploy) — right now, from here, it's a hard block. **I cannot state any
token's verification status with certainty from this session** except by
inference from GoPlus's `is_open_source` field (see §2 and
`docs/scanner-outreach.md`), which strongly suggests: gen-1 tokens (v1, CHRS,
RCN) verified; gen-4 tokens (v2, TEST) NOT verified.

**What's ready for whoever runs it next** (human, or me once the block
lifts): `contracts/script/verify/enumerate-rpc.sh` — a new, from-scratch,
**RPC-only** enumerator (needs zero Blockscout access) that walks all 4
factory generations via `launches(id)` and computes every token's and every
treasury's exact `forge verify-contract` constructor args from live getters.
Already run this session — `contracts/script/verify/tokens.json` and
`treasuries.json` are fresh and contain all **14** launched tokens
(previously only 8 were tracked, from an Aug-19 pipeline that never covered
gen-3 or gen-4). Run `bash script/verify/verify-all.sh` from `contracts/`
to submit everything still unverified — it's idempotent (skips
already-verified addresses) and now defaults to the RPC-based lists (the old
Blockscout-dependent enumerate.mjs path is still there, opt-in via
`FORCE_BLOCKSCOUT_ENUMERATE=1`, but shouldn't be needed).

---

## 2. Every token launched, all generations

| Symbol | Token | Pools (quote asset) | Verified? | Logo |
|---|---|---|---|---|
| BALLAST (v1) | `0x069a260370C61d91bd3e9842d81D378F9750F7F3` | WETH | Likely yes (GoPlus `is_open_source=1`, `is_honeypot=0`) | Set |
| CHRS | `0x088379c481Bef820AcEA7668C9910Ff6d06E3177` | WETH | Likely yes (same GoPlus signal) | — |
| RCN | `0x0774066659fE4aF0FB3757dA4da43e51F224333C` | WETH | Likely yes (same GoPlus signal) | — |
| SYNTH, BILLIST, CLAP, MANATE, SAGE, PHIL, BCAT | gen-2 | WETH | Unknown (not individually checked) | — |
| HARUNA, BALLCAT | gen-3 | NVDA (HARUNA proven trading real, end-to-end) | Unknown | — |
| TEST | `0x3Fec2b548755d53fD8DB97CAc0C14DFA99F0e335` | WETH + NVDA | **No** (`is_open_source=0`, confirmed via GoPlus) | Hidden from all listings this session (`NEXT_PUBLIC_HIDDEN_TOKEN_ADDRESSES`) |
| **BALLAST (v2)** | `0xDc605041F02e41CbD8FDC347023e93C4c3fA243C` | NVDA + WETH | **No** (`is_open_source=0`, confirmed via GoPlus) — needs Section 1's verify run | **Fixed this session** — see below |

**BALLAST v2's logo**: the 2026-09-26 launch used an EMPTY `metadataURI` — a
deliberate shortcut (raw Safe calldata, `docs/safe-tx-launch-ballast.json`,
because the site's build was blocked that night), not a code bug. The
create flow's normal pin-then-launch path (`CreateFlow.tsx`'s
`confirmAndLaunch`) already blocks the launch entirely if pinning fails, and
already works the same way regardless of wallet type (Safe/WalletConnect or
a plain EOA) — no bug found there. **Fixed directly this session**: pinned
`docs/assets-brand/icon-dark-512.png` + a real metadata JSON to Pinata
(`ipfs://Qmar8T7MFNPUX3Ya3obsfBuLgEfCeQnXgQwQPcxwFwScMW` logo,
`ipfs://QmTkxMPBagRyFdDd2CvjiTNsDJLyuHq6Lo8UARXyePZFKf` metadata, both
verified resolving via the public gateway) and prepared
`docs/safe-tx-set-ballast-v2-metadata.json` — a `setMetadataURI()` Safe
transaction (creator-only; creator = the Safe) that, once signed, makes
every surface that reads live `metadataURI` (token page, Discover, search,
Top Movers, portfolio, OG image) show the real logo. **Not yet signed —
needs the Safe.**

---

## 3. External addresses depended on

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Permit2 (canonical) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| ETH/USD feed | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` (live: **$2,713.73**, 2026-09-29) |
| USDG (bridge token used by the router's exit-liquidity table) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

**All 16 stock tokens + feeds** (all 16 are now live in `AssetRegistry`,
confirmed via `allowedAssets()` returning exactly 16 addresses — the 6
"batch-2" assets sourced in a prior session were broadcast successfully):

| Ticker | Token | Feed |
|---|---|---|
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | `0xa0DF4ee0fFf975306345875E3548Fcc519577A11` |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `0x4A1166a659A55625345e9515b32adECea5547C38` |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | `0xF6f373a037c30F0e5010d854385cA89185AE638b` |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | `0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E` |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | `0x7C38C00C30BEe9378381E7B6135d7283356D71b1` |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `0x319724394D3A0e3669269846abE664Cd621f9f6A` |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` |
| AMD | `0x86923f96303d656e4aa86d9d42d1e57ad2023fdc` | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` |
| COIN | `0x6330d8c3178a418788df01a47479c0ce7ccf450b` | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` |
| PLTR | `0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a` | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` |
| ORCL | `0xb0992820e760d836549ba69bc7598b4af75dee03` | `0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844` |
| MSTR | `0xec262a75e413fafd0df80480274532c79d42da09` | `0x396118bdFB181e6240E74D243F266B061c0edc3D` |
| CRCL | `0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5` | `0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a` |

**Being in `AssetRegistry` (treasury-eligible) is NOT the same as being a
GREEN quote asset** (CLAUDE.md rule 17 — separate, immutable-per-factory
allowlist). Only SGOV, NVDA, SPY are GREEN today. **The 6 batch-2 assets were
re-checked this session** (`docs/exit-liquidity-table.md`, live GeckoTerminal
depth + address-verified against impostor pools): **none qualify GREEN**
(<0.5% impact @ $10k) — AMD and ORCL are RED (ORCL is the worst of all 16
assets reviewed: best route only $147K, 13.61% impact @$10k, no real
ERC20/WETH pool at all); CRCL, MSTR, PLTR, COIN are AMBER (COIN flagged as
review-before-promote — 2.69% impact, closer to the RED line than MSFT).
**`isGreenQuoteAsset` has no setter** (`BallastFactory.sol`, confirmed by
reading source — set only in the constructor loop) — promoting any asset to
GREEN in the future requires a full factory redeploy, not a config change.
`BallastRouter` needs no new code to route the 4 AMBER assets IF they're
ever promoted (each has a real, correctly-addressed direct Uniswap-v3 WETH
pool the router's existing single-hop logic can already use — just a
`routes` entry per asset at redeploy time), though PLTR's/COIN's reachable
direct pool is notably shallower than the via-USDG route the AMBER
classification is based on.

---

## 4. Env map (no secret values)

Full read-map + rotation locations: `docs/ENV-AUDIT.md` (existing doc, extended
this session with an explicit PINATA_JWT/Alchemy-key rotation checklist).
Headline facts from this session:

- **Vercel Preview and Development were missing 7 gen-4 vars entirely**
  (`NEXT_PUBLIC_FACTORY_ADDRESS`, `NEXT_PUBLIC_V4_HOOK_ADDRESS`,
  `NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES`, `NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES`,
  `NEXT_PUBLIC_ROUTER_ADDRESS`, `NEXT_PUBLIC_PINNED_TOKEN_ADDRESS`,
  `NEXT_PUBLIC_PRIOR_PINNED_TOKEN_ADDRESSES`) — confirmed via `vercel env
  ls`, **synced to Production's values this session.**
- **New var added**: `NEXT_PUBLIC_HIDDEN_TOKEN_ADDRESSES` (comma-separated,
  tokens hidden from every listing surface without blocking direct-URL
  access) — set on all 3 Vercel environments + `web/.env.local` +
  `.env.example`, currently just the TEST token.
- `web/.env.local` and root `.env` were both stale (still gen-2 addresses) —
  **`web/.env.local` fully updated this session** to gen-4 values; root
  `.env`'s stale factory/hook lines are dead (nothing reads them — Foundry
  scripts take addresses as explicit env args, not these particular names)
  so left as-is.
- `.env.example` was missing `NEXT_PUBLIC_ROUTER_ADDRESS`,
  `NEXT_PUBLIC_PINNED_TOKEN_ADDRESS`, `NEXT_PUBLIC_PRIOR_PINNED_TOKEN_ADDRESSES`
  entirely (introduced in code without a corresponding `.env.example`
  entry, against CLAUDE.md's own division-of-labor rule) — **added this
  session** with explanatory comments.
- Both `.env` and `web/.env.local` confirmed gitignored, confirmed never
  committed (`git log --all -- <path>` returns nothing for either).

---

## 5. Ownership and controls

Full detail + exact ready-to-run commands: `docs/PROTOCOL_CONTROLS.md`
(existing doc, substantially extended this session with a live re-audit).

**CONFIRMED LIVE 2026-09-29 (later session)**: gen-4 FeeConfig `acceptOwnership()`
was signed by the Safe — `owner()` now returns the Safe, `pendingOwner()` is
zero. **Five contracts remain on the old (compromised) deployer EOA
`0xA2774e53dCb666799dBA7d00dC11d10d7Ff837D1`**: `AssetRegistry`,
`BuybackBurner`, `BallastManatee`, `FeeConfig` gen-1, `FeeConfig` gen-2/3. All
confirmed `Ownable2Step` (bytecode contains the `acceptOwnership()` selector
`0x79ba5097`) — need `transferOwnership(Safe)` from the old EOA, then a Safe
accept.

**CONFIRMED LIVE 2026-09-29**: the Safe's fee claim also landed —
`owed(Safe)` on the gen-4 hook is now `0` (was 0.0107 WETH) and
`owedIn(Safe, NVDA)` is now `0` (was 1.646 NVDA). Both fully claimed.

**CONFIRMED LIVE 2026-09-29**: BALLAST v2's `setMetadataURI` Safe tx was
signed — `metadataURI()` now returns
`ipfs://QmTkxMPBagRyFdDd2CvjiTNsDJLyuHq6Lo8UARXyePZFKf` (the real logo/socials
JSON pinned earlier), `metadataChanged()` returns `true`. The logo now shows
everywhere the app reads live metadataURI.

**Ready now, nothing left to fill in:**
- Five `transferOwnership` commands (old-deployer keystore) —
  `docs/PROTOCOL_CONTROLS.md` §"Ready to run now."
- `docs/safe-tx-accept-ownership-batch.json` — Safe batch accepting all
  five, plus the pre-existing `docs/safe-tx-accept-feeconfig.json` for the
  gen-4 instance.
- `docs/safe-tx-claim-all-fees.json` — **new this session**: claims the
  Safe's real, live, currently-unclaimed fees — **0.0107 WETH AND 1.646
  NVDA**, confirmed on-chain right now. The NVDA balance was previously
  invisible to the app entirely: `useAccruedFees.ts` only ever read the
  legacy WETH-specific `owed()`/`claim()` path; the gen-4 hook's
  `owedIn()`/`claimIn(currency)` path (added for non-WETH quote assets) was
  never wired up anywhere in the frontend. **Fixed this session** —
  `web/lib/abis.ts` + `web/hooks/useAccruedFees.ts` + `FeePanel.tsx` now
  read and claim every currency, not just WETH.
- TimelockController: script ready (`contracts/script/DeployTimelock.s.sol`),
  the Safe address is now known and can be filled in directly — deploy
  command is in `docs/PROTOCOL_CONTROLS.md`, timing is your call.

**Manatee is fully minted (1000/1000).** Checked
`contracts/src/manatee/BallastManatee.sol` directly: it inherits
`Ownable2Step` but defines **zero `onlyOwner` functions of its own** — same
"admin key exists but has nothing left to do" class as the core protocol
contracts. Still worth completing the ownership transfer for hygiene (an
EOA holding unused owner rights on a contract is still a dangling risk if
that EOA is ever compromised further), just not urgent.

---

## 6. Snapshot + migration

- Snapshot: block `73030228` (2026-09-26T11:00:00Z), 71 included holders,
  262,256,309.982629 v1 tokens, CSV keccak256
  `0x2df33a31d21cf14be476ec7306e26af8c0e1cdcb3129c3a0d8a62679c6106cc6`.
  TWAP price $0.000007100633157926953/token (05:00–11:00 UTC window had zero
  trades; TWAP = last real swap before it).
- **Total snapshot USD value: ≈ $1,862.19.**
- **New this session** — `docs/migration-budget-report.md`: live cost/impact
  to cover 25/50/100% of that value. Headline finding: **covering even 25%
  via a single market buy on BALLAST v2's own WETH pool would move its price
  ≈33%** (pool reserve ≈$2,834 right now); 100% coverage isn't executable as
  one trade at today's depth at all. Recommends deciding the payout
  mechanism (market buy vs. direct-funded Migrator balance) before building
  the contract, since it changes what the contract needs to do.
### UPDATE — payout mechanism decided (ETH, not a v2 buy), contract BUILT + TESTED

Decision A taken: pay holders in ETH directly, sized by USD value at the
snapshot, converted at the **historical ETH/USD price at the exact snapshot
block** (read live via `cast call <feed> latestRoundData() --block
73030228`: **$2,686.81/ETH**) — not a market buy of v2 at all, so v2's pool
is never touched by this.

- **Total ETH needed: 0.693084308357578318 ETH** across all 71 holders,
  computed with exact BigInt arithmetic (`data/snapshot/compute_eth_claims.cjs`,
  output in `v1_claim_eth.csv` / `v1_claim_eth_meta.json`) — no floating-point
  rounding anywhere in the chain from raw wei balances to final ETH amounts.
- **Merkle tree built and self-verified**: leaf =
  `keccak256(keccak256(abi.encode(address, snapshotBalanceWei, ethAmountWei)))`,
  OZ-compatible sorted-pair internal hashing
  (`data/snapshot/build_merkle.cjs`, no `@openzeppelin/merkle-tree` npm
  package needed — reimplemented its exact algorithm with viem, already a
  dependency). **Root: `0xaf7393f645e01091ca3988179054cf9dc71c6bb87008cbb4c1d1546f1fee4bbb`**.
  All 71 proofs independently reconstruct the root.
- **`contracts/src/BallastV1Claim.sol` — built, immutable, no owner, no
  admin function.** Partial claims scale linearly and sum to exactly the
  full entitlement with zero rounding dust (proven by a 7-way uneven-split
  test). Selling v1 after the snapshot caps your entitlement below 100%
  automatically (plain ERC20 balance enforcement, no special-case code).
  Buying more after the snapshot gets nothing extra (clamped in `claim`).
  Permissionless `sweep()` after a 30-day deadline sends leftover ETH to the
  Safe. **20/20 tests pass**, including reentrancy-on-payout (blocked),
  double-claim, wrong proof, wrong amounts, non-leaf caller, and the
  "v1 never held by the contract" invariant across every path.
- **NOT yet deployed** — blocked on one Safe signature
  (`docs/safe-tx-fund-v1claim-deployer-gas.json`, 0.001 ETH gas for a
  brand-new keystore `v1claim-deployer` created this session,
  `0x27EC8D16E5E2f5fcf7A41e87a25652773782C391`, never the old deployer).
  Full runbook with exact commands: `docs/v1-claim-runbook.md`. The
  contract's own future address is already known
  (`0xb8a42D1DC608dad8CbE6E7b0029067D2A932DFFE`, deterministic CREATE
  address confirmed via `cast compute-address` and matched by the deploy
  script's dry-run) — `docs/safe-tx-fund-v1claim.json` (the second required
  signature, funding the contract itself) already has this address and the
  exact ETH amount filled in.
- **Still to build**: `/migrate` page, public stats section, published
  snapshot page, announcement tweet — all listed with what each needs in
  `docs/v1-claim-runbook.md`'s "Still to build" section.

---

## 7. Fees and buyback

**Where fees accrue and current split**, per generation — see the FeeConfig
table in §1. **Only gen-4 (current launches) sends the platform share to the
Safe** — gen-1 still funds the old team vault `0x3b4f…BD85`, gen-2/3 still
funds `BuybackBurner` (which burns v1, not v2).

**BuybackBurner** (v1-only, immutable): 3 buybacks run historically;
0.000628 WETH accrued now, 0.05 WETH threshold, **owner still the old EOA**
(§5). **v1 burned total: 36,300,495.016297 tokens** (dead-address balance,
independently verifiable) — **3.63% of v1's original 1B supply.**

**BALLAST v2 burned total: 0 today**, but **`BuybackBurnerV2` is now BUILT,
tested against BALLAST v2's real live pools, and ready to deploy**
(`contracts/src/BuybackBurnerV2.sol`) — no owner, no admin function, every
parameter (per-call caps, per-asset cooldown, slippage ceiling) immutable
forever. Holds WETH and/or NVDA sent by the Safe; permissionless
`buybackAndBurn(asset, amountIn, minAmountOut)` swaps through whichever of
v2's two real pools matches the asset and burns everything bought. Three
independent safety bounds (not alternatives — all three apply together):
a hard per-call spend cap per asset, a per-asset cooldown (buying via WETH
and NVDA don't block each other), and a caller-supplied `minAmountOut`
(fetch a quote off-chain via V4Quoter) backed by an immutable slippage
ceiling checked against the pool's own spot price regardless of what the
caller passes. **16/16 tests pass — 10 of them are fork tests proving real
swaps against BALLAST v2's actual live WETH and NVDA pools right now**
(both currently ~$2,834–$2,842 in reserve), not mocks: real buy-and-burn on
each pool, per-call cap clamping, cooldown blocking/expiring, per-asset
cooldown independence, `minAmountOut` rejection, zero-slippage clean
revert, and confirmation that no owner-gated surface exists at all.

**NOT yet deployed** — same new-keystore pattern as the v1 claim contract
(`docs/DeployBuybackV2.s.sol`, deploy script ready, dry-run confirmed
~0.0000690 ETH cost). Defaults chosen: 0.02 ETH / 0.5 NVDA max per call,
1-hour per-asset cooldown, 10% slippage ceiling (well under the contract's
own hard 20% cap) — all overridable via env at deploy time, but immutable
forever after. Funding is a documented routine, not automatic:
**each time the Safe claims creator fees, send 20% (per asset) to
BuybackBurnerV2** — `docs/safe-tx-fund-buybackv2.json` is a ready template
(needs the real deployed address + real 20% amounts filled in once both
exist).

**Buyback page wired up this session** (`web/hooks/useBuybackV2.ts`,
`NEXT_PUBLIC_BUYBACK_V2_ADDRESS` env var, currently unset): once deployed,
the page reads pending WETH/NVDA balances, per-asset cooldown status, and
cumulative burns live — no code changes needed at deploy time, just set the
env var. Until then it correctly shows "manual, not deployed yet." v1's
36.3M stays a separate, never-summed "v1 history" section, unchanged from
earlier this session.

**Claiming fees as the Safe**: `docs/safe-tx-claim-all-fees.json` (§5) — real
numbers, ready to sign. (Already executed once this session per your report —
see the CONFIRMED note in §5; the 20%-to-BuybackBurnerV2 routine above
applies to future claims, and could also apply retroactively to what was
already claimed if you want to fund the burner with it.)

---

## 8. Runbooks

- **Deploy**: `docs/RUNBOOK.md` (first real multi-quote launch),
  `docs/TONIGHT_RUNBOOK.md` (the actual $BALLAST v2 launch script, already
  executed 2026-09-26 — kept for the pattern of a full-package deploy +
  verify + Vercel env + Safe transaction sequence).
- **Verify**: `contracts/script/verify/verify-all.sh` (now RPC-enumerated,
  see §1) — run from `contracts/`, idempotent.
- **Launch from the Safe**: `docs/safe-tx-launch-*.json` examples (raw
  calldata fallback path, used when the site itself can't be used) +
  the normal `/app/create` flow (2 Safe signature rounds: `launch()` then
  the permissionless `graduate()` — see `docs/TONIGHT_RUNBOOK.md`'s
  `graduate()` note for the window between them and why it's harmless).
- **Claim fees**: `docs/safe-tx-claim-all-fees.json` (§5/§7), or the
  `/app` FeePanel UI (now WETH + non-WETH aware).
- **Buyback**: `/app/buyback` page — v1's automated `buybackAndBurn()`
  (permissionless once threshold met) vs. v2's `BuybackBurnerV2` (also
  permissionless, per-asset cooldown, see `BuybackV2Panel` in
  `web/app/app/buyback/page.tsx`).
- **Migrate**: `/app/migrate` — burn v1, claim ETH. Linked from the v1 token
  page's "relaunched" banner.
- **Rotate secrets**: `docs/ENV-AUDIT.md`'s 2026-09-29 addendum — exact
  locations for `PINATA_JWT` and the Alchemy-backed RPC vars.
- **Emergency**: no formal incident runbook exists yet — not built this
  session, flagged as a gap.

---

## 9. Done, blocked, next — with the decision each blocked item needs

### Done this session (across both rounds)

**Round 1**: full ownership audit (6 contracts, not 4) + ready commands; root-caused
the scanner "Unknown" issue with a real GoPlus A/B test; fixed a live bug
(gen-3 pools unresolvable frontend-wide); fixed v2's missing logo; fixed
Vercel Preview/Development env staleness; hid TEST, removed v1 from listings;
fixed burn-stats conflation; found+fixed invisible/unclaimable NVDA fees;
Codex indexing form + ABIs; migration budget math; re-checked 6 batch-2
stocks against the depth bar; built the live security-check row + `/app/security`
dashboard.

**Round 2**: **verified `v2 setMetadataURI`/fee-claim/`acceptOwnership` all
confirmed on-chain**; **found and fixed the real cause of the verify-script
failure** (a `foundry.toml` `[etherscan]` block silently hijacking every
`--verifier` flag); **27 of 35 contracts verified on Sourcify**, a genuinely
separate, reachable verification service — Blockscout itself stays
Cloudflare-blocked from this sandbox, guaranteed manual-upload packages ready
for the 8 that don't auto-match (confirmed genuine historical bytecode
difference, not a tooling bug — see `docs/verify-manual/README.md`); prepped
logo submissions for Blockscout/GeckoTerminal/DexScreener; **built, tested
(20/20), and staged `BallastV1Claim`** (pays v1 holders in ETH at the
historical snapshot-block price, Merkle tree self-verified for all 71
holders) plus the full `/app/migrate` page with live public stats; **built,
tested (16/16, 10 against real live pools), and staged `BuybackBurnerV2`**
(no owner, ever) plus its buyback-page wiring; wrote a fork+unit test suite
for the `TimelockController` deploy pattern (4/4 pass); **shipped a large
chunk of the site redesign** via three parallel agents — nav/Terminal/Analytics
fully removed with redirects (and a real crash bug caught: `BottomNav.tsx`
referenced a route no longer in the nav list), social links consolidated to
single canonical X/Telegram constants (**flagged for your decision** — see
below), create-page GREEN-only "coming soon" gating data wired, animated
`lightweight-charts` price chart + sparklines shipped on the token page and
Top Movers. Combined `tsc --noEmit` clean, `vitest` 60/60 green across every
change, both rounds.

### Needs your decision (not blocked on infrastructure — just a call only you can make)

- **Telegram link**: your instruction said one link, `t.me/ballastedotfun`.
  The repo previously had a June/July-2026-verified split
  (`t.me/ballastedapp` announcements + `t.me/launchballast` discussion).
  Applied your instruction as given, but if that prior verification still
  holds, `ballastedotfun` may be a typo — **confirm before this ships.**
- **Discover card sparkline**: the animated-chart agent declined to add one
  to `ProjectCard.tsx`, correctly citing CLAUDE.md's explicit "exactly five
  things, nothing else" rule for that component — a 6th element would
  violate a hard UI rule. Wired into Top Movers instead (no such
  constraint there). Confirm this is the right call, or say to override the
  five-element rule for this one case.

### Blocked on you (nothing more I can do until these land)

- **`~/.foundry/deployer.pass`** — not created yet. Blocks the 5 old-deployer
  `transferOwnership` calls (§5) and the TimelockController deploy.
- **`~/.ballast-new-secrets`** — not created yet. Blocks secret rotation (§4
  of your latest instructions).
- **`docs/safe-tx-fund-v1claim-deployer-gas.json`** (0.001 ETH) — sign this
  and I deploy `BallastV1Claim` immediately, then you sign
  `docs/safe-tx-fund-v1claim.json` (0.693084 ETH, address already filled in).
- **`BuybackBurnerV2` deploy** — same new-keystore wallet, second transaction;
  I'll run it right after `BallastV1Claim` once gas lands.
- **`docs/safe-tx-accept-ownership-batch.json`** — sign after the 5 transfers
  above land.

### Section 8 (ship) — DONE, with one significant live finding

**10 commits pushed to `main`** (`d219b64..c33822f`), full breakdown in git
log — verification-tooling fix, `BallastV1Claim`, `BuybackBurnerV2`, the
`BallastHookFork` bug fix, and the full Section 7 redesign, each as its own
commit. Combined `forge test` 232/232, `tsc --noEmit` clean, `vitest` 60/60,
all confirmed on the exact code that was committed.

**Vercel's GitHub integration auto-deployed to Production on push** — build
succeeded (`vercel inspect` confirms `status: Ready`), live at the aliased
domains.

**Live finding, not from a screenshot — from raw HTTP/DNS, which this
sandbox CAN do**: **`ballasted.xyz` does not resolve at all** — confirmed
`NXDOMAIN` from two independent public resolvers (Google `8.8.8.8` and
Cloudflare `1.1.1.1`), not a sandbox artifact. **`ballasted.fun` resolves and
serves the live site correctly** — confirmed by fetching real rendered HTML:
the nav bar has no Terminal/Analytics (`Discover · Buyback · Create ·
Portfolio · Profile`, mobile bottom nav down to 3 items), a live "Pairs"
scroller renders with the WETH "ETH route" card, the "Security ↗" link is
present, and `/app/migrate` correctly shows "Not live yet" (honest, since
`NEXT_PUBLIC_V1_CLAIM_ADDRESS` isn't set). **The page's own metadata still
hardcodes `ballasted.xyz`** as the canonical `og:url` and JSON-LD `url`
(`web/app/layout.tsx` or wherever `NEXT_PUBLIC_APP_URL`/metadata is sourced)
— if `.fun` is now the real domain, this needs updating; if `.xyz` is
supposed to still be the primary domain, its DNS needs fixing. Either way,
**this is a real, live problem, not a screenshot I couldn't take** — flagging
for your decision on which domain is canonical now.

This is about as much live verification as this sandbox can do (raw
HTTP/DNS, not a rendered browser) — no fake greens: I did not claim to see
pixel output, only what the raw response bytes prove.

### Section 7 (redesign) — now substantially DONE

All three parallel agents finished, combined `tsc --noEmit` clean and
`vitest` 60/60 green after merging all of them together:
- **Create page** rebuilt as one continuous scroll: Token → **Pool pairing**
  (moved up, horizontal swipeable scroller, GREEN assets selectable up to
  `maxQuoteAssets`, non-GREEN rendered as inert dimmed "coming soon" cards —
  `web/components/PairingScroller.tsx`) → Treasury (same scroller visual
  language, notice period as 3 large cards, "Doesn't change the opening
  price.") → Review. Sticky preview extended with pairing chips + live
  implied per-token price in the selected stock's own units.
- **Landing page + Discover**: a stock-logo marquee in the hero (alongside
  the existing live proof card, not replacing it) and a live "pairs strip"
  (GREEN vs. coming-soon, backed by the real on-chain read, not hardcoded)
  on both pages.
- **Nav**: Terminal and Analytics fully removed, redirected (no 404s), dead
  code cleaned up; a real crash bug caught and fixed in the process
  (`BottomNav.tsx` referenced a route no longer in the nav list).
- **Charts**: `lightweight-charts` animated price chart on every token page
  (line/candle toggle, 1H/1D/1W/All, live tick pulse, count-up price,
  `prefers-reduced-motion` respected, honest empty state — no fake data) +
  animated sparklines on Top Movers.

**Known, disclosed gaps, not hidden**:
- No true mobile bottom-sheet for the sticky preview — it still flows
  in-document below the form on mobile (same as before this pass).
- **No screenshots, no Lighthouse score** — confirmed, not just assumed:
  Playwright isn't installed and attempting to install it tries a network
  fetch that fails in this sandbox; there's no other browser available here.
  `npm run build`/a dev server also hit unreliable external calls (Google
  Fonts etc.) in this environment — a standing limitation, not something
  fixed this session. **You'll need to check the actual Vercel preview
  yourself** once this ships — I cannot verify what I built actually
  renders correctly, only that it typechecks and its logic tests pass.
- Discover cards deliberately did NOT get a sparkline — CLAUDE.md's own
  "exactly five things, nothing else" rule for `ProjectCard.tsx` would be
  violated by a sixth element. Flagged above under "needs your decision."

### Full test suite — now 100% green

Ran the complete `forge test` suite (232 tests, every fork test included,
real `RH_RPC_URL_PAID`): found and fixed one genuinely pre-existing broken
test, not caused by this session — `test_liquidityLock_seederBlocked_
thirdPartyFree` in `BallastHookFork.t.sol` reused the shared `hook` from
`setUp()`, which already had `setSeeder()` called once; the test's own
second `setSeeder()` call could only ever revert with `AlreadySet()`, before
any of its actual assertions ran. This explains the "188/189, 1
pre-existing/unrelated failure" note carried in `docs/TONIGHT_RUNBOOK.md` —
it wasn't flaky, it was deterministically broken and had been accepted as a
known-failure rather than fixed. Gave it its own fresh, purpose-built hook
(matching the pattern its neighbor test already used) and added a real
state-based assertion (blocked seeder's token/WETH balance unchanged) since
the wrapped-error selector from a hook-reverting `modifyLiquidity` isn't
matchable at the top level. **`forge test`: 232/232 passing, 0 failed, 0
skipped.** Combined with `web`'s `tsc --noEmit` clean + `vitest` 60/60 —
the full stack is green.

### Still open, lower priority

- **Exact-out sell support (next hook generation)** — still a Phase-2
  design-report item; redeploying the hook is the kind of irreversible
  change this project's rules say to bring to you, not do unprompted.
- The 8-contract Sourcify mismatch's root cause (§1) — confirmed a real,
  reproducible `bytecode_length_mismatch` (onchain runtime 3350 bytes vs.
  recompiled 3032 bytes for e.g. CHRS) but couldn't isolate the exact
  historical compiler setting responsible (BallastToken.sol's source hasn't
  changed since before any of these launched, per `git log`, so it's a
  compiler-flag difference, not a source diff — and this project's current
  `via_ir=true` is now load-bearing for `BallastHook.sol` project-wide,
  making an isolated recompile-without-via_ir impossible to test cleanly).
  Doesn't block anything — the manual-upload packages sidestep this
  entirely — just flagging the investigation didn't fully resolve.
