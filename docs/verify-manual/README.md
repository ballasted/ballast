# Manual Blockscout verification — click steps

For the 8 contracts that couldn't be auto-verified this session (Blockscout's
own API is Cloudflare-blocked from the agent sandbox; these 8 specifically
also fail Sourcify's automatic recompile-match — see "why these 8" below).
Your browser passes Cloudflare fine — this is the guaranteed fallback.

**Do CHRS first** (smallest, proves the steps work), then the rest in any order.

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
successfully verified every OTHER token/treasury on the same template. Tried
and ruled out: disabling `via_ir` (`FOUNDRY_VIA_IR=false`) — no change. Most
likely explanation, not yet confirmed: these specific contracts were deployed
at a slightly different commit of `BallastToken.sol`/`ProjectTreasury.sol`
than the one currently on `main` (the source has evolved — metadataURI,
Ownable2Step, etc. were added at different points per git history) — i.e. the
byte mismatch may be genuinely correct, not a tooling bug, and verifying
these 8 for real might need checking out the exact historical commit at each
one's deploy block before compiling. Not chased further this session
(archaeology on 8 non-critical legacy contracts vs. the rest of this punch
list) — flagging the open question rather than guessing.

Blockscout's own "Standard JSON Input" upload doesn't have this problem: you
give it your own JSON + args directly, no auto-recompile-and-diff step, so
this should just work regardless of which historical commit is correct.
