#!/usr/bin/env bash
# Patient finisher: long cooldown, then submit every still-unverified token +
# treasury WITHOUT --watch (2 API calls each), retrying on rate-limit. Ends with
# a status sweep. Designed to run in the background unattended.
set -uo pipefail
cd /c/Users/Lenovo/ballast/contracts
BS="https://robinhoodchain.blockscout.com"
VURL="$BS/api/"

vstatus(){ node -e "fetch('$BS/api/v2/addresses/$1').then(r=>r.json()).then(j=>console.log(j.is_verified)).catch(()=>console.log('err'))"; }

submit(){ # $1 addr  $2 path  $3 args
  for try in 1 2 3 4; do
    OUT=$(forge verify-contract "$1" "$2" \
      --verifier blockscout --verifier-url "$VURL" \
      --compiler-version 0.8.28 --num-of-optimizations 200 \
      --constructor-args "0x$3" 2>&1)
    if echo "$OUT" | grep -qi "Too many"; then
      echo "   rate-limited (try $try), cooling 90s"; sleep 90; continue
    fi
    echo "$OUT" | grep -E "Submitted|GUID|already|Error|Response" | head -3
    return 0
  done
}

echo "cooldown 240s..."; sleep 240

echo "== extract treasuries =="
node script/verify/extract-treasury.mjs 2>&1 | tail -3

echo "== tokens (skip verified) =="
node -e 'const t=require("./script/verify/tokens.json");for(const x of t)console.log(x.token,x.args)' \
| while read A ARGS; do
  if [ "$(vstatus "$A")" = "true" ]; then echo "skip $A"; else
    echo ">> token $A"; submit "$A" "src/BallastToken.sol:BallastToken" "$ARGS"; sleep 45
  fi
done

echo "== treasuries (skip verified) =="
node -e 'const t=require("./script/verify/treasuries.json");for(const x of t)console.log(x.treasury,x.args)' \
| while read A ARGS; do
  if [ "$(vstatus "$A")" = "true" ]; then echo "skip $A"; else
    echo ">> treasury $A"; submit "$A" "src/ProjectTreasury.sol:ProjectTreasury" "$ARGS"; sleep 45
  fi
done

echo "== waiting 60s for queue to settle, then status sweep =="; sleep 60
echo "-- TOKENS --"
node -e 'const t=require("./script/verify/tokens.json");(async()=>{for(const x of t){const j=await(await fetch("'$BS'/api/v2/addresses/"+x.token)).json();console.log(x.symbol.padEnd(8),x.token,"verified="+j.is_verified);await new Promise(s=>setTimeout(s,3000));}})()'
echo "-- TREASURIES --"
node -e 'const t=require("./script/verify/treasuries.json");(async()=>{for(const x of t){const j=await(await fetch("'$BS'/api/v2/addresses/"+x.treasury)).json();console.log(x.sym.padEnd(8),x.treasury,"verified="+j.is_verified);await new Promise(s=>setTimeout(s,3000));}})()'
echo "FINISH-DONE"
