# BALLAST — BuybackBurner deploy + wiring (PowerShell).
# Run STAGE BY STAGE. Do NOT paste the whole file at once: stages 3 and 4 are
# irreversible (broadcast, fee rerouting). Verify between them.
# Nothing here hardcodes a secret — secrets load from your root .env at runtime.

# ── STAGE 0 · toolchain on PATH + load .env into this session ────────────────
$env:Path = "C:\Users\Lenovo\.foundry\bin;$env:Path"
Get-Content C:\Users\Lenovo\ballast\.env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k,$v = $_ -split '=',2
  Set-Item -Path "Env:$($k.Trim())" -Value ($v.Trim().Trim('"').Trim("'"))
}
Set-Location C:\Users\Lenovo\ballast\contracts

# ── STAGE 1 · buyback deploy args ────────────────────────────────────────────
$env:PROTOCOL_OWNER_ADDRESS   = "0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1"  # EOA owner (Safe parked)
$env:BALLAST_TOKEN            = "0x069a260370C61d91bd3e9842d81D378F9750F7F3"  # $BALLAST, verified on-chain (launch 0)
$env:BUYBACK_POOL_HOOK        = "0x9C15c992E4De3711715C8B7D717EF46e474680CC"  # prior hook — PERMANENT (in the pool key)
# current-only fee routing (your choice) => buyback fees accrue only on the current
# hook, so sweep only it. (If you later also route the PRIOR FeeConfig to the buyback,
# add 0x9C15…680CC here via setClaimHooks — retunable, no redeploy.)
$env:BUYBACK_CLAIM_HOOKS      = "0x743102aa1De955b5F0Fada1377B6E545Fdb080cc"
$env:BUYBACK_THRESHOLD_WEI    = "50000000000000000"   # 0.05 ETH — YOUR call, retunable via setThreshold
$env:BUYBACK_MAX_SLIPPAGE_BPS = "500"                 # 5% — YOUR call, retunable (hard ceiling 2000)
$env:POOL_MANAGER             = "0x8366a39CC670B4001A1121B8F6A443A643e40951"  # v4 PoolManager
$env:WETH                     = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"  # aeWETH
# (DEPLOYER_PRIVATE_KEY comes from .env, loaded in stage 0. POOL_MANAGER/WETH are set
#  explicitly here because .env only has their NEXT_PUBLIC_*_ADDRESS forms, not the
#  bare names DeployBuyback reads.)

# ── STAGE 2 · DRY-RUN (no broadcast). Expect a printed address + no revert. ───
forge script script/DeployBuyback.s.sol:DeployBuyback --rpc-url $env:RH_RPC_URL_PAID
# >>> STOP. Read the output. Only continue if it simulated cleanly. <<<

# ── STAGE 3 · BROADCAST + verify (IRREVERSIBLE; spends gas) ──────────────────
forge script script/DeployBuyback.s.sol:DeployBuyback --rpc-url $env:RH_RPC_URL_PAID --broadcast --verify --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663
$run = Get-Content broadcast\DeployBuyback.s.sol\4663\run-latest.json | ConvertFrom-Json
$BUYBACK = ($run.transactions | Where-Object { $_.contractName -eq 'BuybackBurner' -and $_.transactionType -eq 'CREATE' } | Select-Object -First 1).contractAddress
"BuybackBurner deployed at: $BUYBACK"
# >>> STOP. Confirm $BUYBACK is set and the contract verified on Blockscout. <<<

# ── STAGE 4 · route platform fees into the buyback (CURRENT-ONLY — your choice)─
# Decision made: set ONLY the current FeeConfig. New-launch platform fees fund the
# buyback; $BALLAST/CHRS/RCN keep sending their platform share (~50% of the 1% fee,
# while the referrer allowlist is empty) to the prior vault 0x3b4f…BD85 — unchanged.
# To ALSO fund from $BALLAST's own trading later: uncomment the prior-FeeConfig line
# AND add 0x9C15…680CC to claimHooks (stage 1) via setClaimHooks.
cast send 0xC0B895bc683bf4ACA30c7277D42d068E0973A594 "setPlatformVault(address)" $BUYBACK --rpc-url $env:RH_RPC_URL_PAID --private-key $env:DEPLOYER_PRIVATE_KEY   # current FeeConfig
# cast send 0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304 "setPlatformVault(address)" $BUYBACK --rpc-url $env:RH_RPC_URL_PAID --private-key $env:DEPLOYER_PRIVATE_KEY   # prior FeeConfig — INTENTIONALLY LEFT OFF
"current FC vault (should be the buyback): $(cast call 0xC0B895bc683bf4ACA30c7277D42d068E0973A594 'platformVault()(address)' --rpc-url $env:RH_RPC_URL_PAID)"
"prior   FC vault (should stay 0x3b4f…): $(cast call 0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304 'platformVault()(address)' --rpc-url $env:RH_RPC_URL_PAID)"

# ── STAGE 5 · app config ─────────────────────────────────────────────────────
Add-Content C:\Users\Lenovo\ballast\web\.env.local "`nNEXT_PUBLIC_BUYBACK_ADDRESS=$BUYBACK"
# Then set it on Vercel (Production) and redeploy:
#   vercel env add NEXT_PUBLIC_BUYBACK_ADDRESS production   # paste $BUYBACK when prompted
#   vercel --prod
"Set NEXT_PUBLIC_BUYBACK_ADDRESS=$BUYBACK locally. Now add it on Vercel + redeploy."
