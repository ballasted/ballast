# Codex indexing form — filled

Every address, event, and link a third-party indexer (Codex or similar) needs
to index BALLAST correctly. Ground truth verified live on-chain 2026-09-29
(`cast call`/`cast sig-event` against `$RH_RPC_URL_PAID`), not from docs or
memory. ABIs exported as JSON: `docs/abi/*.json`.

## Chain

- Chain ID: `4663` (mainnet). Testnet `46630` — not used for any live token below.
- Public RPC: `https://rpc.mainnet.chain.robinhood.com`
- Explorer: `https://robinhoodchain.blockscout.com`
- GitHub (public): https://github.com/ballasted/ballast (default branch `main`)

## Contracts — current generation (gen-4, live since 2026-09-26)

| Contract | Address | ABI file |
|---|---|---|
| BallastFactory | `0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67` | `docs/abi/BallastFactory.json` |
| BallastHook | `0x4eb2dd759f4d6524e66057d1adc10c26e40142cc` | `docs/abi/BallastHook.json` |
| BallastSeeder | `0x690241daf35efdf34e0b726aceb451bd901858db` | `docs/abi/BallastSeeder.json` |
| BallastRouter v1 (superseded, never wired into the frontend) | `0xc422e0a6ca75d1ffafd77f72b710b2ef3aef50e1` | `docs/abi/BallastRouter.json` |
| BallastRouterV2 (current, pay with ETH into any quote asset via Fables or Ramses) | `0xa0Aba92d3D99eC905BcFc8a6aCfC889468a747E0` | `docs/abi/BallastRouterV2.json` |
| FeeConfig (gen-4) | `0xE09F093595045E8765F420Cb12E0AA250910E5AD` | `docs/abi/FeeConfig.json` |
| AssetRegistry (shared, all generations) | `0x427764d0d19aB765c35A41A5aa4771580307dA81` | `docs/abi/AssetRegistry.json` |
| BackingLens | `0x73Ac3574c8743553f41C6E25F92A145b5c0e7240` | `docs/abi/BackingLens.json` (redeployed 2026-07-30, see `docs/ENV-AUDIT.md`) |
| BallastToken (per-launch template) | one per launch, see below | `docs/abi/BallastToken.json` |
| ProjectTreasury (per-launch template) | one per launch, see below | `docs/abi/ProjectTreasury.json` |

Prior generations (still live, still hold real tokens — see
`docs/seeded-hook-history.md` for the full factory↔hook↔seeder table):

| Gen | Factory | Hook | Tokens |
|---|---|---|---|
| 1 | `0x069974136c78Cf0F2162463B95321E59F56523D8` | `0x9C15c992E4De3711715C8B7D717EF46e474680CC` | BALLAST v1, CHRS, RCN |
| 2 | `0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1` | `0x743102aa1De955b5F0Fada1377B6E545Fdb080cc` | SYNTH, BILLIST, CLAP, MANATE, SAGE, PHIL, BCAT |
| 3 | `0x3eb5532e982931cad40d0416adbd7930a57965ae` | `0x4915f612c89100bEbE9279355fab27022D0940cc` | HARUNA, BALLCAT |

## Events, signatures, topic0 (computed live via `cast sig-event`, not assumed)

| Event | Signature | topic0 | Emitted by |
|---|---|---|---|
| Launched | `Launched(uint256,address,address,address,uint256,string)` | `0x341e1a8477856ce51ab6bc9293a7a07e030d00df94b79c7d4724e62af10faac7` | BallastFactory |
| Graduated | `Graduated(address,address,uint256)` | `0xc80e4bc2e24e04790ada4491d25a0af02878a6351bd22acaf7555be1d0da9b11` | BallastFactory |
| PoolSeeded | `PoolSeeded(address,address,bytes32,int24,uint256)` | `0x9b8820b4cc6015b8d24d60b6861e1c3802ddd8a9faacb3879310718b39222b62` | BallastFactory |
| MetadataUpdated | `MetadataUpdated(string,string,uint256)` | `0xcde160be3ea458925068d9041a438d850f20f733f5ff0f9afcd1b6dde5766802` | BallastToken (per launch) |
| FeeTaken | `FeeTaken(address,address,uint256,address,address,address)` | `0x29a9e3b9974c843c693204fdfc986f5be6976901e3fbc42d69f946026b09d2f6` | BallastHook |
| Claimed | `Claimed(address,uint256)` | `0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a` | BallastHook (WETH claims) |
| ClaimedIn | `ClaimedIn(address,address,uint256)` | `0xca1d9ae3ca42e4e277e16c71854f40c15a92d45114877df5b89cc4cf4bd25cd6` | BallastHook (non-WETH claims, e.g. NVDA) |

`Launched(id, creator, token, treasury, noticePeriod, metadataURI)` — `id` and
`creator` and `token` are indexed (3 indexed topics + topic0, per
`BallastFactory.sol`'s event declaration). `treasury`/`noticePeriod`/
`metadataURI` are in the data field.

## Which contract holds the token supply between launch and graduate

**The BallastFactory itself.** `BallastToken`'s constructor mints the full
1,000,000,000-token supply to `mintTo`, and every launch passes the factory's
own address as `mintTo` (confirmed by reading `BallastFactory.sol`'s `launch()`
and independently by querying a live launch: `BallastToken.factory()` returns
the factory address, and `balanceOf(factory)` is the full 1e27 supply
immediately after `launch()`, dropping to 0 the moment `graduate()` seeds the
pool(s) — verified on BALLAST v2 and TEST, both currently graduated with
`balanceOf(factory) == 0`). The factory is not a custodian in the trust sense —
it has no admin function to move that balance anywhere except through
`graduate()`'s fixed seeding logic.

## Per-launch addresses (BallastToken + ProjectTreasury), all 4 generations

All 14 tokens ever launched, enumerated live via `launches(id)` across every
factory (not from an indexer or cache) — see
`contracts/script/verify/tokens.json` / `treasuries.json` for the full
machine-readable list (token, treasury, creator, and — for tokens — the exact
ABI-encoded constructor args, ready for `forge verify-contract`).

| Symbol | Token | Treasury | Factory (generation) |
|---|---|---|---|
| BALLAST (v1) | `0x069a260370C61d91bd3e9842d81D378F9750F7F3` | `0x4e2037b6fb622e681ce05e4e48c548ea915b4e59` | gen-1 |
| CHRS | `0x088379c481Bef820AcEA7668C9910Ff6d06E3177` | `0xd7d628a8c16eb2e80b025b7cfe415a19bb6d94af` | gen-1 |
| RCN | `0x0774066659fE4aF0FB3757dA4da43e51F224333C` | `0x0dd54346a97df7d2700542b5584e9cc9cceb75cd` | gen-1 |
| PHIL | `0x0107442A5EceDA6B3A108E0d55368deB91b18eE6` | `0xe6d21c979f10cec8b1d43587e81c5fb006446d4d` | gen-2 |
| SYNTH | `0x0af65D3C291Da6Ef80Fd4C49ba01Ba9492f77C29` | `0xe62d6354234ad9e4093707206340ffe653e470c4` | gen-2 |
| BILLIST | `0x010B1525757229EE340E0ad42D8cB263B4fa963b` | `0xae51f7fda747273f4d2f5a1e9069d8d164282387` | gen-2 |
| CLAP | `0x0B5d000bAC84bB49d541e5a68a2dC0F6B47eA16f` | `0x1203bddc44da1f136b622c5efc7ba78a1e3004bd` | gen-2 |
| MANATE | `0x016A61AB5899967e4a5f101F6C5227441EFcBEc6` | `0x0259a212f98c51beb5e30463383f1fdab2b29837` | gen-2 |
| SAGE | `0x02E9f3D0e5DEa634576bE04AF971C4cCB5f6c447` | see `treasuries.json` | gen-2 |
| BCAT | `0x09a5c807F2be23d37dCa3f7eD9d2dC182bA20dEb` | see `treasuries.json` | gen-2 |
| HARUNA | `0xf7e04472bE047263885480DAb2C42AB75b1386c1` | see `treasuries.json` | gen-3 |
| BALLCAT | `0xa9B587b4945C587455ad28C16B032e0034dB3A44` | see `treasuries.json` | gen-3 |
| TEST | `0x3Fec2b548755d53fD8DB97CAc0C14DFA99F0e335` | `0x3a1F64760824Fef3E84C231175b44C442aE3dA6a` | gen-4 |
| BALLAST (v2) | `0xDc605041F02e41CbD8FDC347023e93C4c3fA243C` | `0x3b916C765A218B6BcDD376411acD3AA3Efd43737` | gen-4 |

## Blockscout links (per contract, pattern)

`https://robinhoodchain.blockscout.com/address/<address>` for every address
above. `https://robinhoodchain.blockscout.com/tx/<hash>` for transactions.
Verification status of each: pending this session's Section 1 work (Blockscout
itself is Cloudflare-blocking this sandbox as of 2026-09-29 — see
`docs/BALLAST_STATE.md` for current status and the ready-to-run verify script).
