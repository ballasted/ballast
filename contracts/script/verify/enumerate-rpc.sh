#!/usr/bin/env bash
# Enumerate every BallastToken + ProjectTreasury across ALL FOUR factory
# generations, and compute each one's verify-contract constructor args,
# purely from RPC reads (cast call / cast abi-encode). Unlike enumerate.mjs
# + extract-args.mjs + extract-treasury.mjs (the original Aug-19 pipeline),
# this needs ZERO Blockscout access — only $RH_RPC_URL_PAID (or any working
# RPC). Written 2026-09-29 because Blockscout's own API/web UI was
# Cloudflare-blocked from the agent sandbox at the time (intermittent per
# earlier sessions), but chain reads worked fine.
#
# Writes script/verify/tokens.json and script/verify/treasuries.json in the
# EXACT shape verify-all.sh / finish.sh already expect — nothing downstream
# needs to change. Safe to re-run any time a new token launches; it always
# recomputes from live chain state, never from a stale cache.
#
# Usage: RPC=$RH_RPC_URL_PAID bash script/verify/enumerate-rpc.sh
# Run from contracts/.
set -uo pipefail
RPC="${RPC:?set RPC=<rpc url>}"
REGISTRY=0x427764d0d19aB765c35A41A5aa4771580307dA81   # constant across every generation

FACTORIES=(
  0x069974136c78Cf0F2162463B95321E59F56523D8
  0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1
  0x3eb5532e982931cad40d0416adbd7930a57965ae
  0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67
)

echo "[" > script/verify/tokens.json
echo "[" > script/verify/treasuries.json
FIRST_T=1
FIRST_R=1

for FACTORY in "${FACTORIES[@]}"; do
  COUNT=$(cast call "$FACTORY" "launchCount()(uint256)" --rpc-url "$RPC")
  echo ">> factory $FACTORY: $COUNT launch(es)" >&2
  for ((i=0; i<COUNT; i++)); do
    read -r TOKEN TREASURY CREATOR <<< "$(cast call "$FACTORY" "launches(uint256)(address,address,address)" "$i" --rpc-url "$RPC" | tr '\n' ' ')"

    NAME=$(cast call "$TOKEN" "name()(string)" --rpc-url "$RPC" | tr -d '"')
    SYMBOL=$(cast call "$TOKEN" "symbol()(string)" --rpc-url "$RPC" | tr -d '"')
    SUPPLY=$(cast call "$TOKEN" "totalSupply()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
    TOK_CREATOR=$(cast call "$TOKEN" "creator()(address)" --rpc-url "$RPC")
    MINT_TO="$FACTORY"   # BallastFactory always mints to itself at launch
    METAURI=$(cast call "$TOKEN" "launchMetadataURI()(string)" --rpc-url "$RPC" | tr -d '"')

    TOKEN_ARGS=$(cast abi-encode "constructor(string,string,uint256,address,address,string)" "$NAME" "$SYMBOL" "$SUPPLY" "$TOK_CREATOR" "$MINT_TO" "$METAURI" | sed 's/^0x//')

    [ "$FIRST_T" = "1" ] && FIRST_T=0 || echo "," >> script/verify/tokens.json
    node -e "console.log(JSON.stringify({factory:'$FACTORY',id:$i,creator:'$CREATOR',token:'$TOKEN',name:process.argv[1],symbol:'$SYMBOL',args:'$TOKEN_ARGS'},null,2))" -- "$NAME" >> script/verify/tokens.json
    echo "   token  $SYMBOL  $TOKEN" >&2

    NOTICE=$(cast call "$TREASURY" "noticePeriod()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
    TREASURY_ARGS=$(cast abi-encode "constructor(address,address,uint256,address)" "$TOKEN" "$TOK_CREATOR" "$NOTICE" "$REGISTRY" | sed 's/^0x//')

    [ "$FIRST_R" = "1" ] && FIRST_R=0 || echo "," >> script/verify/treasuries.json
    node -e "console.log(JSON.stringify({sym:'$SYMBOL',token:'$TOKEN',treasury:'$TREASURY',args:'$TREASURY_ARGS'},null,2))" >> script/verify/treasuries.json
    echo "   treasury  $SYMBOL  $TREASURY" >&2
  done
done

echo "]" >> script/verify/tokens.json
echo "]" >> script/verify/treasuries.json
echo "wrote script/verify/tokens.json + script/verify/treasuries.json" >&2
