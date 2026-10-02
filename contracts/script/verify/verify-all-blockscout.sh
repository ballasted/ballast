#!/usr/bin/env bash
# Blockscout-primary verification — run this from a machine that ISN'T
# Cloudflare-blocked (the sandbox that built this repo's tooling is; your
# laptop confirmed it isn't). GoPlus reads Blockscout's verification status,
# not Sourcify's, so this is what actually flips is_open_source for scanners.
#
# Order: $BALLAST v2 (token + treasury) first, then every core singleton
# contract, then every prior-generation singleton, then every launched
# token + treasury across all 4 generations. Idempotent — forge's own
# is-verified check skips anything already verified on Blockscout (no
# --skip-is-verified-check flag here, so that check stays ON).
#
# The 8 contracts with a genuine bytecode_length_mismatch (CHRS, PHIL,
# SYNTH, SAGE, BCAT tokens, SAGE+BCAT treasuries, BackingLens) WILL fail
# here too — same recompile problem on any verifier. That's expected; their
# guaranteed-working fallback is the manual upload packages already built
# in docs/verify-manual/<name>/ (Standard JSON Input, ready to paste into
# Blockscout's UI by hand). This script does not touch those packages.
#
# Requires: RH_MAINNET_RPC_URL (or RH_RPC_URL_PAID) set in your shell —
# needed for --guess-constructor-args on the singleton contracts below.
#
# Usage: paste this whole block into Git Bash, from anywhere inside the repo.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"
echo "== git pull =="
git pull

cd contracts

RPC="${RH_MAINNET_RPC_URL:-${RH_RPC_URL_PAID:-}}"
if [ -z "$RPC" ]; then
  echo "!! Set RH_MAINNET_RPC_URL (or RH_RPC_URL_PAID) first — needed for --guess-constructor-args." >&2
  exit 1
fi

BS_URL="${BLOCKSCOUT_URL:-https://robinhoodchain.blockscout.com}"
GAP="${GAP:-4}"

vfy() {  # $1=addr $2=contractPath [--constructor-args 0x... | --guess-constructor-args]
  local addr="$1" path="$2"; shift 2
  echo ">> $addr  ($path)"
  forge verify-contract "$addr" "$path" --chain-id 4663 \
    --verifier blockscout --verifier-url "$BS_URL/api/" \
    "$@" 2>&1 | grep -E "already verified|Submitted|successfully|Error|Job ID|NotFound|Fail" | head -6
  sleep "$GAP"
}

echo
echo "================ 1) \$BALLAST v2 — token + treasury (priority) ================"
vfy 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C src/BallastToken.sol:BallastToken \
  --constructor-args 0x00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000033b2e3c9fd0803ce8000000000000000000000000000000efc97e16a24d2434c7138a2634e554a0631ac079000000000000000000000000a32b9870a1b77544eb4e044cae9f3e62a1f71f670000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000742616c6c61737400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000742414c4c415354000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000

vfy 0x3b916C765A218B6BcDD376411acD3AA3Efd43737 src/ProjectTreasury.sol:ProjectTreasury \
  --constructor-args 0x000000000000000000000000dc605041f02e41cbd8fdc347023e93c4c3fa243c000000000000000000000000efc97e16a24d2434c7138a2634e554a0631ac0790000000000000000000000000000000000000000000000000000000000093a80000000000000000000000000427764d0d19ab765c35a41a5aa4771580307da81

echo
echo "================ 2) Core (gen-4, current) singletons ================"
vfy 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67 src/BallastFactory.sol:BallastFactory --guess-constructor-args --rpc-url "$RPC"
vfy 0x4eb2dd759f4d6524e66057d1adc10c26e40142cc src/BallastHook.sol:BallastHook --guess-constructor-args --rpc-url "$RPC"
vfy 0x690241daf35efdf34e0b726aceb451bd901858db src/BallastSeeder.sol:BallastSeeder --guess-constructor-args --rpc-url "$RPC"
vfy 0xc422e0a6ca75d1ffafd77f72b710b2ef3aef50e1 src/BallastRouter.sol:BallastRouter --guess-constructor-args --rpc-url "$RPC"
# BallastRouterV2 (current, Fables/Ramses, 2026-10-02) — already verified on Sourcify
# (exact match); this just mirrors that onto Blockscout natively. Needs --guess
# because its constructor takes the two fixed-table array args, not a bare address list.
vfy 0xa0Aba92d3D99eC905BcFc8a6aCfC889468a747E0 src/BallastRouterV2.sol:BallastRouterV2 --guess-constructor-args --rpc-url "$RPC"
vfy 0xE09F093595045E8765F420Cb12E0AA250910E5AD src/FeeConfig.sol:FeeConfig --guess-constructor-args --rpc-url "$RPC"
vfy 0x427764d0d19aB765c35A41A5aa4771580307dA81 src/AssetRegistry.sol:AssetRegistry --guess-constructor-args --rpc-url "$RPC"
vfy 0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770 src/BackingLens.sol:BackingLens --guess-constructor-args --rpc-url "$RPC"

echo
echo "================ 3) Prior-generation singletons (gen-1/2/3) ================"
vfy 0x069974136c78Cf0F2162463B95321E59F56523D8 src/BallastFactory.sol:BallastFactory --guess-constructor-args --rpc-url "$RPC"
vfy 0x9C15c992E4De3711715C8B7D717EF46e474680CC src/BallastHook.sol:BallastHook --guess-constructor-args --rpc-url "$RPC"
vfy 0xbe043844e0B7713B4c7841DCCB3C4e1c6eA5eCF9 src/BallastSeeder.sol:BallastSeeder --guess-constructor-args --rpc-url "$RPC"
vfy 0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304 src/FeeConfig.sol:FeeConfig --guess-constructor-args --rpc-url "$RPC"

vfy 0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1 src/BallastFactory.sol:BallastFactory --guess-constructor-args --rpc-url "$RPC"
vfy 0x743102aa1De955b5F0Fada1377B6E545Fdb080cc src/BallastHook.sol:BallastHook --guess-constructor-args --rpc-url "$RPC"
vfy 0x7830E1F67598e8c76ce1fFf79b1D2A3E915325E4 src/BallastSeeder.sol:BallastSeeder --guess-constructor-args --rpc-url "$RPC"
vfy 0xc0b895bc683bf4aca30c7277d42d068e0973a594 src/FeeConfig.sol:FeeConfig --guess-constructor-args --rpc-url "$RPC"

vfy 0x3eb5532e982931cad40d0416adbd7930a57965ae src/BallastFactory.sol:BallastFactory --guess-constructor-args --rpc-url "$RPC"
vfy 0x4915f612c89100bEbE9279355fab27022D0940cc src/BallastHook.sol:BallastHook --guess-constructor-args --rpc-url "$RPC"
vfy 0xFC5362e535a20c99D75C2595dfF6f7bA1E99A523 src/BallastSeeder.sol:BallastSeeder --guess-constructor-args --rpc-url "$RPC"
# (gen-3 shares gen-2's FeeConfig — already verified above)

echo
echo "================ 4) Misc (BuybackBurner v1, Manatee) ================"
vfy 0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be src/BuybackBurner.sol:BuybackBurner --guess-constructor-args --rpc-url "$RPC"
vfy 0xfd3534f2a6ca756e95e5d2ff7bd287954b856e4b src/manatee/BallastManatee.sol:BallastManatee --guess-constructor-args --rpc-url "$RPC"
vfy 0xbd602bddb55b3a200015bafcd975e54a93549327 src/manatee/ManateeRenderer.sol:ManateeRenderer --guess-constructor-args --rpc-url "$RPC"

echo
echo "================ 5) Every launched token + treasury, all generations ================"
echo "-- tokens --"
node -e 'const t=require("./script/verify/tokens.json");for(const x of t)console.log(x.token,x.args)' \
| while read -r ADDR ARGS; do
  vfy "$ADDR" src/BallastToken.sol:BallastToken --constructor-args "0x$ARGS"
done

echo "-- treasuries --"
node -e 'const t=require("./script/verify/treasuries.json");for(const x of t)console.log(x.treasury,x.args)' \
| while read -r ADDR ARGS; do
  vfy "$ADDR" src/ProjectTreasury.sol:ProjectTreasury --constructor-args "0x$ARGS"
done

echo
echo "== done — paste this whole terminal output back =="
echo "GoPlus re-check (wait a minute or two for it to re-index Blockscout, then run):"
echo "  node script/verify/goplus.mjs"
echo "Look for BALLAST 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C -> is_open_source=\"1\""
echo "Other scanners (DexScreener, GeckoTerminal's own badge) read Blockscout too — check"
echo "https://dexscreener.com/robinhood/0xe33f257d541070d29d429cd29ec7fafaf9bafb666f0a54e62ad7eca782ed4ab1"
echo "and the pool page on GeckoTerminal directly; no API re-check needed, just reload."
