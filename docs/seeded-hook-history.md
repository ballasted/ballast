# Hook / factory / seeder history

Every BallastHook + BallastSeeder generation ever deployed, and which factory
and tokens live under it. A pool's hook is baked into its PoolKey PERMANENTLY
at graduation — redeploying the hook never moves existing pools, so this list
must be updated (never removed from) on every future hook redeploy, and its
newest-first order must match `NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES` in
`.env`/Vercel exactly (see `lib/contracts.ts`'s `FACTORY_HOOK_PAIRS`).

This file exists because on 2026-09-25 `NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES` in
production was missing the oldest entry below, silently making BALLAST/CHRS/
RCN's real, liquid pools invisible to the entire frontend. `factory.seeder()`
is a public getter — the seeder address doesn't strictly need recording here
to be *readable*, but the hook does, since nothing on-chain enumerates hook
history the way `BallastFactory.seeder()` does for seeders.

| Generation | Factory | Hook | Seeder (`factory.seeder()`) | Tokens launched |
|---|---|---|---|---|
| 1 (oldest) | `0x069974136c78Cf0F2162463B95321E59F56523D8` | `0x9C15c992E4De3711715C8B7D717EF46e474680CC` | `0xbe043844e0B7713B4c7841DCCB3C4e1c6eA5eCF9` | BALLAST, CHRS, RCN |
| 2 | `0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1` | `0x743102aa1De955b5F0Fada1377B6E545Fdb080cc` | `0x7830E1F67598e8c76ce1fFf79b1D2A3E915325E4` | SYNTH, BILLIST, CLAP, MANATE, SAGE, PHIL, BCAT |
| 3 (current) | `0x3eb5532e982931cad40d0416adbd7930a57965ae` | `0x4915f612c89100bEbE9279355fab27022D0940cc` | `0xFC5362e535a20c99D75C2595dfF6f7bA1E99A523` | HARUNA, BALLCAT |

All addresses above verified directly on-chain 2026-09-25 (`cast call <factory> "seeder()(address)"`, and PoolManager `Initialize` events decoded from each generation's real `launch()`/`graduate()` transactions) — not sourced from memory or docs.
