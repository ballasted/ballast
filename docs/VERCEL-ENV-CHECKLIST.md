# Vercel environment checklist

The app reads these at runtime. Local (`web/.env.local`) and Vercel are **separate
stores** — a var set locally is NOT on Vercel unless you also add it in the Vercel
dashboard (Project → Settings → Environment Variables, Production scope). This file
is the reconciliation list. Nothing here is a secret except the two marked SECRET,
whose values must be copied from `web/.env.local` and never committed.

Generated 2026-08-04 from `web/.env.local`. Re-verify after any redeploy.

---

## ⚠️ Prod-breaking if missing (verify these FIRST)

A redeploy left `$BALLAST` and `CHRS` on a *prior* factory + hook. If these two
union vars aren't on Vercel, those tokens have no resolvable pool in production →
no price, no swaps, and a spurious "launch incomplete" panel. This has broken prod
once already.

| Var | Value to set | Why it breaks prod if absent |
|---|---|---|
| `NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES` | `0x069974136c78cf0f2162463b95321e59f56523d8` | $BALLAST lives on the prior factory; graduation/resume reads miss it |
| `NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES` | `0x9C15c992E4De3711715C8B7D717EF46e474680CC` | prior-hook pools ($BALLAST, CHRS) keyed + fee-claimed under the old hook |

## Current core (the active redeploy — confirm these are the ones on Vercel)

| Var | Value |
|---|---|
| `NEXT_PUBLIC_FACTORY_ADDRESS` | `0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1` |
| `NEXT_PUBLIC_LENS_ADDRESS` | `0x73ac3574c8743553f41c6e25f92a145b5c0e7240` |
| `NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS` | `0x427764d0d19aB765c35A41A5aa4771580307dA81` |
| `NEXT_PUBLIC_V4_HOOK_ADDRESS` | `0x743102aa1De955b5F0Fada1377B6E545Fdb080cc` |
| `NEXT_PUBLIC_FEE_CONFIG_ADDRESS` | `0xc0b895bc683bf4aca30c7277d42d068e0973a594` |
| `NEXT_PUBLIC_SEEDER_ADDRESS` | `0x7830e1f67598e8c76ce1fff79b1d2a3e915325e4` |

## Chain infra (stable — confirm present)

`NEXT_PUBLIC_WETH_ADDRESS` `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` ·
`NEXT_PUBLIC_POOL_MANAGER_ADDRESS` `0x8366a39CC670B4001A1121B8F6A443A643e40951` ·
`NEXT_PUBLIC_STATE_VIEW_ADDRESS` · `NEXT_PUBLIC_V4_QUOTER_ADDRESS` ·
`NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS` · `NEXT_PUBLIC_ETH_USD_FEED_ADDRESS`
(copy all from `web/.env.local`).

## App config

| Var | Value / note |
|---|---|
| `NEXT_PUBLIC_APP_URL` | production URL (NOT `localhost:3000` — must be the real domain on Vercel) |
| `NEXT_PUBLIC_USE_MAINNET` | `true` |
| `NEXT_PUBLIC_IPFS_GATEWAY` | `https://gateway.pinata.cloud/ipfs/` (must stay cross-origin, never a ballasted.xyz origin) |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | from `web/.env.local` — wallet picker breaks if absent |
| `RPC_UPSTREAM_URL` | **SECRET** — keyed Alchemy URL for the `/api/rpc` server proxy |
| `PINATA_JWT` | **SECRET** — server-side pinning; uploads break if absent |

## Set only once the corresponding contract is deployed

| Var | When |
|---|---|
| `NEXT_PUBLIC_METADATA_DENYLIST_ADDRESS` | after `DeployDenylist` (Section B step 3). Empty = fail-open, app still works |
| `NEXT_PUBLIC_BUYBACK_ADDRESS` | after `DeployBuyback` (Section B step 4). Unset = buyback page shows "not live yet" |

## Known unused (do NOT delete — reserved)

`X_OAUTH_*`, `SESSION_SECRET`, `WEBSITE_VERIFY_SALT`, `DATABASE_URL`,
`NEXT_PUBLIC_INDEXER_URL` — verified-links / indexer features designed but not built.
No code reads them; keep them reserved.

---

**How to verify what's actually on Vercel:** `vercel env ls` (or the dashboard). I
cannot read the Vercel store from the repo, so treat every row above as UNVERIFIED
until you've checked it there.
