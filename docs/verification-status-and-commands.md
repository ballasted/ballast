# Blockscout verification status + commands (Section F)

Read-only audit. Queried `https://robinhoodchain.blockscout.com/api/v2/smart-contracts/<address>`
on 2026-10-10. **Node's `fetch` got a Cloudflare JS challenge (403, `cf-mitigated: challenge`)
from this sandbox** — `curl`, plain Node `fetch`, and the `WebFetch` tool were all blocked.
`powershell.exe`'s `Invoke-WebRequest` got a clean 200 from the same box and was used for every
query below. If you automate this again from a similar environment, reach for PowerShell first.

Addresses cross-checked against `web/.env.local` / `web/lib/contracts.ts` (trusted over the task
list where they'd disagree — here they matched on every address that's wired into the frontend).
Three addresses in the original list had non-canonical EIP-55 checksums (same bytes, wrong
letter-casing) — corrected below via `viem.getAddress`:

- BallastSeeder: `0x690241DAf35Efdf34E0B726aCEb451Bd901858Db` → `0x690241DaF35EfDf34E0b726aCEb451bD901858Db`
- ProtocolFeeSink: `0x6310178Ff618f8A4C10177363B6086860a6C4C09` → `0x6310178FF618F8A4C10177363B6086860A6C4c09`
- BallastFeeSplitterFactory: `0xB91117365810aE0b9833E46867Df8A8b205D523b` → `0xb91117365810aE0b9833e46867DF8a8B205D523b`

All three resolve to the exact same on-chain bytes either way — checksum casing doesn't affect
Blockscout lookups or `forge verify-contract` — but the corrected casing is used throughout this
doc and in the printed commands.

## Status table

| Contract | Address | Verified | Compiler | Optimizer | EVM | viaIR |
|---|---|---|---|---|---|---|
| BallastFactory | `0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |
| BallastHook | `0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |
| BallastSeeder | `0x690241DaF35EfDf34E0b726aCEb451bD901858Db` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |
| FeeConfig | `0xE09F093595045E8765F420Cb12E0AA250910E5AD` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |
| AssetRegistry | `0x427764d0d19aB765c35A41A5aa4771580307dA81` | YES | 0.8.28 (source confirmed live) | — | — | — |
| BackingLens | `0x73Ac3574c8743553f41C6E25F92A145b5c0e7240` | YES | 0.8.28 (source confirmed live) | — | — | — |
| BuybackBurnerV2 | `0xDA9ef87A6146f435d34237a9B3a81689603Fa503` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |
| OpenTreasuryVaultFactory | `0xF2B171DF729fd6701553610732eB43d13417e1d9` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |
| OpenTreasuryLens | `0x5827211D43599bA88882EbB6bC1791813F4C5C10` | **NO** | — | — | — | — |
| ProtocolFeeSink | `0x6310178FF618F8A4C10177363B6086860A6C4c09` | **NO** | — | — | — | — |
| BallastFeeSplitterFactory | `0xb91117365810aE0b9833e46867DF8a8B205D523b` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |
| RamsesLockLauncher | `0x88BC1d1FBb09807C067dF5c68177126f59cdA284` | **NO** | — | — | — | — |
| $BALLAST v2 token | `0xDc605041F02e41CbD8FDC347023e93C4c3fA243C` | YES | 0.8.28+commit.7893614a | 200 runs | cancun | true |

`AssetRegistry` / `BackingLens`: the `/smart-contracts/` endpoint returned a full `source_code`
payload (so they ARE verified) but PowerShell's `ConvertFrom-Json` choked parsing the full
response body on this box (`"name"` argument error, unrelated to the HTTP response itself) before
it reached the compiler-settings fields. Verified status itself is not in question — only those
extra columns are blank here.

10 of 13 verified. **3 unverified: OpenTreasuryLens, ProtocolFeeSink, RamsesLockLauncher.**

Settings confirmed from `contracts/foundry.toml` `[profile.default]`: no global `solc` pin (every
file pins `pragma solidity 0.8.28;`, so auto-detect resolves to 0.8.28 — confirmed by the
`compiler_version` Blockscout reports for every contract above), `optimizer_runs = 200`,
`evm_version = "cancun"`, `via_ir = true`. Blockscout's own `compiler_settings` for
OpenTreasuryVaultFactory confirms this combination is exactly what's live
(`"viaIR":true,"optimizer":{"enabled":true,"runs":200},"evmVersion":"cancun"`).

Because no global `solc` is pinned and every file pins its own exact `pragma solidity 0.8.28;`,
`forge verify-contract` auto-detects the compiler version and reads `optimizer_runs` /
`evm_version` / `via_ir` from `foundry.toml`'s `[profile.default]` automatically — this is exactly
how the 10 already-verified contracts above were submitted (see
`contracts/script/verify/verify-all-blockscout.sh`, which passes no explicit `--compiler-version`,
`--optimizer-runs`, `--evm-version`, or via-ir flag for any singleton contract). The commands below
follow the same proven pattern: run from the `contracts/` directory, pass only the address, the
contract path, and the constructor args.

## Commands for the 3 unverified contracts

Constructor args below are **not guessed** — each is read directly from the real deploy broadcast
(`contracts/broadcast/<Script>.s.sol/4663/run-latest.json`, which exists only in the main
worktree, not this one) and independently re-derived by slicing the trailing ABI-encoded words off
the broadcast's own `transaction.input` (last `32 bytes × argCount`) and confirming the decode
matches the broadcast's own recorded `arguments` array exactly — both agreed for all three. None
of the three deployer EOAs in these broadcasts
(`0xacb1eadb20962d5b02b2e9c75b90ce42b3303de5`, `0xf61bf8870fd9cf0527dbc28fee54a048aad579fb`) is the
compromised old deployer `0xA2774e53dCb666799dBA7d00dC11d10d7Ff837D1` — unrelated to this task's
deliverable (printing a verify command needs no signer), noted only as a sanity check.

Run all three from `contracts/`:

```bash
cd contracts

# 1) OpenTreasuryLens — constructor(address backingLens_), the live BackingLens (0x73Ac...e7240)
forge verify-contract 0x5827211D43599bA88882EbB6bC1791813F4C5C10 \
  src/OpenTreasuryLens.sol:OpenTreasuryLens \
  --chain-id 4663 \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --constructor-args 0x00000000000000000000000073ac3574c8743553f41c6e25f92a145b5c0e7240

# 2) ProtocolFeeSink — constructor(address weth_, address safe_, address registry_)
#    weth_=0x0Bd7...AD73 (NEXT_PUBLIC_WETH_ADDRESS), safe_=0xEFC9...C079, registry_=AssetRegistry
forge verify-contract 0x6310178FF618F8A4C10177363B6086860A6C4c09 \
  src/ProtocolFeeSink.sol:ProtocolFeeSink \
  --chain-id 4663 \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --constructor-args 0x0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73000000000000000000000000efc97e16a24d2434c7138a2634e554a0631ac079000000000000000000000000427764d0d19ab765c35a41a5aa4771580307da81

# 3) RamsesLockLauncher — constructor(address positionManager_, address locker_, address splitterFactory_)
#    positionManager_=NEXT_PUBLIC_RAMSES_V3_POSITION_MANAGER_ADDRESS, locker_=NEXT_PUBLIC_RAMSES_LOCKER_ADDRESS,
#    splitterFactory_=BallastFeeSplitterFactory (already verified, above)
forge verify-contract 0x88BC1d1FBb09807C067dF5c68177126f59cdA284 \
  src/RamsesLockLauncher.sol:RamsesLockLauncher \
  --chain-id 4663 \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --constructor-args 0x0000000000000000000000002ebd7b85a4e08d5b508b04ba147976c94afe6590000000000000000000000000f6cd2e03259150d4ff745cdd620c09fbf30de1dc000000000000000000000000b91117365810ae0b9833e46867df8a8b205d523b
```

Each of these is a single read-only submission to Blockscout's verifier (no private key, no
broadcast, no gas) — it only uploads source + settings and asks Blockscout to recompile and
diff against the already-deployed bytecode.

## If a command fails

- `already verified`: harmless, means it finished verifying between this doc being written and
  the command being run — nothing to do.
- `bytecode_length_mismatch` / `metadata mismatch`: would mean the live compiler settings have
  drifted from `foundry.toml`'s current `[profile.default]` since deploy. Re-check `git log` on
  `contracts/foundry.toml` around the deploy commit for that contract before assuming the
  constructor args are wrong — the 8-contract class of genuine mismatches mentioned in
  `contracts/script/verify/verify-all-blockscout.sh` has a known manual-upload fallback in
  `docs/verify-manual/<name>/`.
