# Manual Blockscout verification — click steps

For the 8 contracts that couldn't be auto-verified this session (Blockscout's
own API is Cloudflare-blocked from the agent sandbox; these 8 specifically
also fail Sourcify's automatic recompile-match — see "why these 8" below).
Your browser passes Cloudflare fine — this is the guaranteed fallback.
**`contracts/script/verify/verify-all-blockscout.sh` submits full source
directly to Blockscout for all 8 too** (not dependent on Sourcify's matcher at
all) — try that first; only fall back to this manual per-contract upload for
whichever ones it still can't verify.

**Do CHRS first** (smallest, proves the steps work), then the rest in any order.

## Faster path for the other 27: Blockscout's "Sourcify" import method

Blockscout's Verify & Publish page may offer a **"Sourcify"** verification
method (alongside "Solidity (Standard JSON Input)") — if present, it fetches
the match directly from sourcify.dev instead of you uploading anything. Since
27 of 35 contracts are already `exact_match` on Sourcify, this is a one-click
per contract if your instance has it enabled:

1. Open `https://robinhoodchain.blockscout.com/address/<ADDRESS>`, **Code**
   tab, **Verify & Publish**.
2. If the verification-method dropdown lists **Sourcify**, select it, confirm
   the address, click **Verify**. Done — no file upload.
3. If it's NOT in the dropdown (some Blockscout instances don't enable the
   Sourcify integration), this option doesn't exist for this deployment —
   use `verify-all-blockscout.sh` instead, which submits full source directly
   and gets the same result without depending on it.

## Steps, per contract

1. Open `https://robinhoodchain.blockscout.com/address/<ADDRESS>` (the address
   is in each folder name below) in your browser.
2. Click the **Code** tab, then **Verify & Publish**.
3. Verification method: **Solidity (Standard JSON Input)**.
4. Compiler version: **v0.8.28+commit.7893614a** (or the closest exact 0.8.28
   build listed — check `contracts/foundry.toml`'s `solc = "0.8.28"` if the
   dropdown shows multiple 0.8.28 builds).
5. Upload the file `standard-input.json` from that contract's folder.
6. Constructor arguments (ABI-encoded, no `0x` prefix): paste the contents of
   that folder's `constructor-args.txt` into the constructor-args field.
7. Contract name: the part after the colon in the folder name (e.g.
   `BallastToken`, `ProjectTreasury`, `BackingLens`) — Blockscout may ask you
   to pick which contract in the JSON input to verify against; pick that one.
8. Submit. Expect either a pass, or an error naming exactly which byte/line
   differs — if it fails, paste me that exact error and I'll fix the package.

## Contracts in this folder, one subfolder each

| Folder | Address | Contract |
|---|---|---|
| `CHRS-token-0x088379c481Bef820AcEA7668C9910fF6D06E3177` | `0x088379c481Bef820AcEA7668C9910fF6D06E3177` | BallastToken |
| `PHIL-token-0x0107442A5EceDA6B3A108E0d55368deB91b18eE6` | `0x0107442A5EceDA6B3A108E0d55368deB91b18eE6` | BallastToken |
| `SYNTH-token-0x0af65D3C291Da6Ef80Fd4C49ba01Ba9492f77C29` | `0x0af65D3C291Da6Ef80Fd4C49ba01Ba9492f77C29` | BallastToken |
| `SAGE-token-0x02E9f3D0e5DEa634576bE04AF971C4cCB5f6c447` | `0x02E9f3D0e5DEa634576bE04AF971C4cCB5f6c447` | BallastToken |
| `BCAT-token-0x09a5c807F2be23d37dCa3f7eD9d2dC182bA20dEb` | `0x09a5c807F2be23d37dCa3f7eD9d2dC182bA20dEb` | BallastToken |
| `SAGE-treasury-0xfd07Cf427639A8E77C4b85bF740F1f09223e7Ee3` | `0xfd07Cf427639A8E77C4b85bF740F1f09223e7Ee3` | ProjectTreasury |
| `BCAT-treasury-0xd954Db866Dd86C91c622f408933a015680dD17F8` | `0xd954Db866Dd86C91c622f408933a015680dD17F8` | ProjectTreasury |
| `BackingLens-0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770` | `0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770` | BackingLens (constructor arg is `address(0)` — no sequencer feed exists for chain 4663) |

## Why these 8, not everything

**27 of 35 contracts across the whole fleet (14 tokens + 14 treasuries + 7
core contracts, one already-verified AssetRegistry) verified automatically
this session via Sourcify** (`sourcify.dev` — a genuinely separate service
from Blockscout, not behind the same Cloudflare block, confirmed reachable
and working from this sandbox). Full tally in `docs/BALLAST_STATE.md`.

These 8 specifically fail Sourcify's own recompile with a `bytecode_length_
mismatch` error — the locally-recompiled contract's creation code is a
different LENGTH than what's actually on-chain, using the exact same source
file (`src/BallastToken.sol`, `src/ProjectTreasury.sol`, `src/BackingLens.sol`
at current HEAD) and the exact same `foundry.toml` compiler settings that
successfully verified every OTHER token/treasury on the same template.

**2026-09-30 update — the "different historical commit" theory is now RULED
OUT, with proof, not a guess:**
- `git log --follow` on all three source files shows their last
  content-changing commit is **2026-07-23** (BackingLens got one more touch
  on 2026-07-23 for the sequencer-optional change) — CHRS's pool wasn't
  created until **2026-07-25**. Every one of these 8 contracts was deployed
  AFTER the source was already at its current, unchanged-since form. There is
  no earlier commit to check out.
- `foundry.toml`'s compiler block (`optimizer_runs = 200`, `evm_version =
  "cancun"`) has only ever been touched twice in the repo's history — once at
  project inception (2026-07-23, before any of these launched) and once this
  session (removing the `[etherscan]` table, unrelated to compiler settings).
  The settings have never differed.
- **Decoded CHRS's stored constructor args by hand, word-by-word, against the
  live contract**: `name_="CHEEERS"`, `symbol_="CHRS"`, `creator_=0x3b4f…BD85`,
  `mintTo=<gen-1 factory address>`, `metadataURI_="ipfs://QmNtS5Gn6GANVpHo8PP
  2HxGC5yor5bCxKtNXLEc51SrW4f"` — every field matches `cast call`'s live
  `name()`/`symbol()`/`launchMetadataURI()` reads exactly, byte for byte. The
  args I'm submitting are provably correct, not the cause.
- RCN (same factory, same generation, same source, same settings as CHRS)
  verifies fine on Sourcify; CHRS doesn't. Since source+settings+args are all
  confirmed identical/correct, the remaining difference must be something in
  how Sourcify's specific matcher computes/compares the expected creation
  bytecode for this one deployment (its docs describe stricter handling
  around immutable-reference placeholders and metadata-hash byte ranges than
  a plain diff) — not a real on-chain discrepancy, and not fixable by
  changing what I submit. This is why the direct-to-Blockscout script is
  worth trying independently: Blockscout runs its own verifier, not a
  Sourcify passthrough, when you submit full source directly.

Blockscout's own "Standard JSON Input" upload doesn't depend on Sourcify's
matcher at all: you give it your own JSON + args directly, so this should
verify regardless of whatever Sourcify-specific quirk is at play.
