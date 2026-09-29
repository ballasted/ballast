#!/usr/bin/env bash
# Verify every BALLAST-launched token (and its ProjectTreasury) — Sourcify
# first (works from anywhere, no Cloudflare issue), Blockscout opportunistically
# second (best-effort; its own verify may still 403 from some networks, but a
# subsequent success there is a bonus, never required). Idempotent: skips
# anything already verified per Sourcify's own status endpoint.
#
# IMPORTANT: this depends on NO [etherscan] table existing in foundry.toml for
# this chain — its mere presence makes `forge verify-contract` silently ignore
# `--verifier sourcify` and force (broken) Etherscan-shaped requests instead.
# See the long comment in contracts/foundry.toml, added 2026-09-29, before ever
# re-adding one.
#
# Usage:   bash script/verify/verify-all.sh
# Run from the contracts/ directory.
set -uo pipefail

BS="${BLOCKSCOUT_URL:-https://robinhoodchain.blockscout.com}"
SOURCIFY="${SOURCIFY_URL:-https://sourcify.dev/server/}"
GAP="${GAP:-5}"   # seconds between contracts

is_verified() {  # $1 = address -> prints "true"/"false" (Sourcify's own record)
  node -e "fetch('${SOURCIFY}v2/contract/4663/$1').then(r=>r.status===200?r.json():null).then(j=>console.log(Boolean(j&&j.match))).catch(()=>console.log('false'))"
}

do_verify() {  # $1=addr $2=contractPath $3=argsHex
  echo ">> verifying $1 ($2) via Sourcify"
  forge verify-contract "$1" "$2" --chain-id 4663 \
    --verifier sourcify --verifier-url "$SOURCIFY" \
    --constructor-args "0x$3" 2>&1 \
    | grep -E "Submitted|Verification|successfully|Too many|Error|Job ID" | head -6
  # Opportunistic second attempt against Blockscout directly — succeeds when
  # Cloudflare isn't in the way (varies by network/session); failure here is
  # silent and never blocks the script, since Sourcify's result above is what
  # `is_verified` actually checks.
  forge verify-contract "$1" "$2" --chain-id 4663 \
    --verifier blockscout --verifier-url "$BS/api/" \
    --constructor-args "0x$3" >/dev/null 2>&1 || true
}

echo "== enumerating launched tokens =="
# 2026-09-29: script/verify/tokens.json + treasuries.json are already fresh
# (enumerate-rpc.sh, an RPC-only enumerator covering all 4 factory generations
# incl. BALLAST v2 + TEST — no Blockscout read needed, unlike the original
# enumerate.mjs/extract-args.mjs/extract-treasury.mjs pipeline below). Re-run
# `RPC=$RH_RPC_URL_PAID bash script/verify/enumerate-rpc.sh` first if a new
# token has launched since; otherwise skip straight to verifying.
if [ "${FORCE_BLOCKSCOUT_ENUMERATE:-0}" = "1" ]; then
  node script/verify/enumerate.mjs 2>/dev/null > script/verify/tokens.raw.json
  export TOKENS_JSON="$(cat script/verify/tokens.raw.json)"
  node script/verify/extract-args.mjs >/dev/null
  node script/verify/extract-treasury.mjs >/dev/null
fi

echo "== tokens =="
node -e 'const t=require("./script/verify/tokens.json");for(const x of t)console.log(x.token,x.args)' \
| while read ADDR ARGS; do
  V=$(is_verified "$ADDR")
  if [ "$V" = "true" ]; then echo "skip (verified) $ADDR"; continue; fi
  do_verify "$ADDR" "src/BallastToken.sol:BallastToken" "$ARGS"
  sleep "$GAP"
done

echo "== treasuries =="
node -e 'const t=require("./script/verify/treasuries.json");for(const x of t)console.log(x.treasury,x.args)' \
| while read ADDR ARGS; do
  V=$(is_verified "$ADDR")
  if [ "$V" = "true" ]; then echo "skip (verified) $ADDR"; continue; fi
  do_verify "$ADDR" "src/ProjectTreasury.sol:ProjectTreasury" "$ARGS"
  sleep "$GAP"
done

echo "== done =="
