# BALLAST — environment variable audit

Generated 2026-07-27 (UI-density Phase 5). Source of truth: every `process.env.*`
/ `vm.env*` / `env.*` read in `web/`, `indexer/`, and `contracts/script/`, cross-
referenced against root `.env.example`, root `.env`, and `web/.env.local`.

**Secrets are never printed here.** Public `NEXT_PUBLIC_*` values (canonical chain
addresses, the public reown id) are shown because they ship to the browser anyway;
keys are shown as `<secret>`.

---

## 1. What the deployed site needs RIGHT NOW vs later

**Needed now** (the Vercel site is broken or degraded without them):

| Variable | Why | If unset |
|---|---|---|
| `NEXT_PUBLIC_FACTORY_ADDRESS` | launch registry, every read | app shows "Not configured" |
| `NEXT_PUBLIC_LENS_ADDRESS` | backing reads | app shows "Not configured" |
| `NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS` | allowlist / create flow | app shows "Not configured" |
| `NEXT_PUBLIC_V4_HOOK_ADDRESS` | pool identity | Buy/Sell disabled |
| `NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS` | swap execution | Buy/Sell disabled |
| `NEXT_PUBLIC_STATE_VIEW_ADDRESS` | pool spot/liquidity | Buy/Sell disabled |
| `NEXT_PUBLIC_V4_QUOTER_ADDRESS` | swap quotes | no quote shown |
| `NEXT_PUBLIC_POOL_MANAGER_ADDRESS` | pool id / slot0 | spot price missing |
| `NEXT_PUBLIC_WETH_ADDRESS` | pool pair / wrap | Buy/Sell disabled |
| `NEXT_PUBLIC_ETH_USD_FEED_ADDRESS` | USD pricing of market/backing | USD figures missing |
| `PINATA_JWT` (server) | pins logo + metadata on launch | Create flow can't pin |

**Optional now / has a safe fallback:**

| Variable | Fallback if unset |
|---|---|
| `NEXT_PUBLIC_FEE_CONFIG_ADDRESS` | create flow shows a muted "FeeConfig not configured" instead of the 50/35/15 split. **Currently unset in `web/.env.local`.** |
| `RPC_UPSTREAM_URL` (server) | `/api/rpc` proxies the rate-limited public RPC |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | wallet modal falls back to injected-only discovery |
| `NEXT_PUBLIC_IPFS_GATEWAY` | default `https://gateway.pinata.cloud/ipfs/` |
| `NEXT_PUBLIC_APP_URL` | default `https://ballasted.xyz` (metadata/OG/sitemap only) |

**Later features (not needed for the site to work today):**

| Variable | Feature | Host |
|---|---|---|
| `NEXT_PUBLIC_INDEXER_URL` | analytics volume/trades, holders, trade feed | Vercel (public) |
| `PONDER_RPC_URL_4663`, `PONDER_START_BLOCK`, `RH_RPC_URL_PAID` | the Ponder indexer itself | indexer host (not Vercel) |
| `DATABASE_URL`, `WEBSITE_VERIFY_SALT` | website/X verification (designed, not built — see note) | verification host |
| `DEPLOYER_PRIVATE_KEY`, `PROTOCOL_OWNER_ADDRESS`, `PROTOCOL_VAULT_ADDRESS`, `PROBE_*`, `ASSET_REGISTRY`, `POOL_MANAGER`, `WETH`, `ETH_USD_FEED`, `TOKEN_*`, `FEED_*`, `RH_*`, `BLOCKSCOUT_URL` | Foundry deploy / allowlist scripts | local shell only (never Vercel) |

---

## 2. Full read-map

Legend: **file** = where it belongs · **read by** = the process that reads it ·
**P/S** = public / secret.

### Frontend — read by the Next.js app (`web/`)
| Variable | File | Read by | P/S | Value |
|---|---|---|---|---|
| `NEXT_PUBLIC_FACTORY_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x069974136c78Cf0F2162463B95321E59F56523D8` |
| `NEXT_PUBLIC_LENS_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770` |
| `NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x427764d0d19aB765c35A41A5aa4771580307dA81` |
| `NEXT_PUBLIC_V4_HOOK_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x9C15c992E4De3711715C8B7D717EF46e474680CC` |
| `NEXT_PUBLIC_FEE_CONFIG_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | **unset** (deploy FeeConfig, then fill) |
| `NEXT_PUBLIC_WETH_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| `NEXT_PUBLIC_POOL_MANAGER_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| `NEXT_PUBLIC_STATE_VIEW_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| `NEXT_PUBLIC_V4_QUOTER_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| `NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| `NEXT_PUBLIC_ETH_USD_FEED_ADDRESS` | web/.env.local + Vercel | `lib/contracts.ts` | P | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | web/.env.local + Vercel | `lib/wagmi.ts` | P | `253bb93c024c823876265f33e0546a3f` |
| `NEXT_PUBLIC_IPFS_GATEWAY` | web/.env.local + Vercel | `lib/ipfs.ts` | P | `https://gateway.pinata.cloud/ipfs/` |
| `NEXT_PUBLIC_INDEXER_URL` | web/.env.local + Vercel | `lib/indexer.ts` | P | unset (indexer not deployed) |
| `NEXT_PUBLIC_APP_URL` | web/.env.local + Vercel | `layout.tsx`, `robots.ts`, `sitemap.ts` | P | prod: `https://ballasted.xyz` |
| `PINATA_JWT` | web/.env.local + Vercel | `app/api/pin/route.ts` | **S** | `<secret>` |
| `RPC_UPSTREAM_URL` | web/.env.local + Vercel | `app/api/rpc/route.ts` | **S** | `<secret>` (Alchemy) |

### Indexer — read by Ponder (`indexer/ponder.config.ts`), NOT Vercel
| Variable | P/S | Value |
|---|---|---|
| `PONDER_RPC_URL_4663` | S | `<secret>` (dedicated 4663 RPC) |
| `RH_RPC_URL_PAID` | S | `<secret>` (fallback paid RPC) |
| `PONDER_START_BLOCK` | P | factory deploy block |

### Foundry scripts — read by `contracts/script/*` via `vm.env*`, local shell only
`DEPLOYER_PRIVATE_KEY` (**S**), `PROTOCOL_OWNER_ADDRESS`, `PROTOCOL_VAULT_ADDRESS`,
`PROBE_STOCK_TOKEN`, `PROBE_AMOUNT`, `PROBE_FEED`, `ASSET_REGISTRY`, `POOL_MANAGER`,
`WETH`, `ETH_USD_FEED`, `TOKEN_<TICKER>`, `FEED_<TICKER>`, `RH_*`, `BLOCKSCOUT_URL`.
These never go to Vercel.

---

## 3. Flags

### Set but NOT read (safe to leave, but not doing anything)
In `web/.env.local`:
- `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_USE_MAINNET` — the chain is hardcoded to 4663
  in `web/lib/chain.ts` (deliberate: an env-driven target was the original
  testnet/mainnet mismatch bug). Kept for reference only.
- `NEXT_PUBLIC_MULTICALL3_ADDRESS` — multicall3 is hardcoded in `lib/wagmi.ts`.
- `NEXT_PUBLIC_PERMIT2_ADDRESS` — Permit2 is hardcoded (canonical) in `lib/contracts.ts`.
- `NEXT_PUBLIC_POSITION_MANAGER_ADDRESS`, `NEXT_PUBLIC_USDG_ADDRESS` — recorded for
  completeness; nothing reads them today.

In root `.env` (stale copy): `X_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`, `SESSION_SECRET`
— the paid X OAuth route was dropped for the free oEmbed check; these are dead and
were removed from `.env.example`. `DATABASE_URL`, `WEBSITE_VERIFY_SALT` are reserved
for the not-yet-built verification feature.

### Read but MISSING from `.env.example`
None — every variable read by code is documented in `.env.example`.

### Action item surfaced by this audit
`NEXT_PUBLIC_FEE_CONFIG_ADDRESS` is read by the create flow but is **absent from
`web/.env.local`**, so the fee split renders as "FeeConfig not configured". Deploy
FeeConfig (or point at the deployed address) and set it in `.env.local` + Vercel.

---

## BLOCK 1 — root `.env` (local: Foundry deploy + allowlist + probe)

```dotenv
# Chain
RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
RH_TESTNET_CHAIN_ID=46630
RH_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com
RH_MAINNET_CHAIN_ID=4663
RH_RPC_URL_PAID=            # <secret> Alchemy 4663 HTTPS URL
BLOCKSCOUT_URL=https://robinhoodchain.blockscout.com

# Deploy keys (LOCAL ONLY — never Vercel, never commit)
DEPLOYER_PRIVATE_KEY=       # <secret> fresh gas-only wallet
PROTOCOL_OWNER_ADDRESS=     # multisig for mainnet
PROTOCOL_VAULT_ADDRESS=     # fee sink

# Deployed core (fill from the deploy)
NEXT_PUBLIC_FACTORY_ADDRESS=0x069974136c78Cf0F2162463B95321E59F56523D8
NEXT_PUBLIC_LENS_ADDRESS=0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770
NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS=0x427764d0d19aB765c35A41A5aa4771580307dA81
NEXT_PUBLIC_V4_HOOK_ADDRESS=0x9C15c992E4De3711715C8B7D717EF46e474680CC
NEXT_PUBLIC_FEE_CONFIG_ADDRESS=   # deploy FeeConfig, then fill

# External infra (verified)
NEXT_PUBLIC_WETH_ADDRESS=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
NEXT_PUBLIC_MULTICALL3_ADDRESS=0xcA11bde05977b3631167028862bE2a173976CA11
NEXT_PUBLIC_PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
NEXT_PUBLIC_POOL_MANAGER_ADDRESS=0x8366a39CC670B4001A1121B8F6A443A643e40951
NEXT_PUBLIC_POSITION_MANAGER_ADDRESS=0x58daec3116aae6D93017bAAea7749052E8a04fA7
NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS=0x8876789976dEcBfCbBbe364623C63652db8C0904
NEXT_PUBLIC_V4_QUOTER_ADDRESS=0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
NEXT_PUBLIC_STATE_VIEW_ADDRESS=0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
NEXT_PUBLIC_ETH_USD_FEED_ADDRESS=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
SEQUENCER_UPTIME_FEED_ADDRESS=    # none published for 4663 — leave blank

# Deploy-script bare names
ASSET_REGISTRY=0x427764d0d19ab765c35a41a5aa4771580307da81
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
ETH_USD_FEED=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
# TOKEN_<TICKER> / FEED_<TICKER> allowlist pairs — see .env.example

# IPFS
PINATA_JWT=                 # <secret> pinFileToIPFS + pinJSONToIPFS scopes
NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/

# Verification / DB (later feature)
WEBSITE_VERIFY_SALT=        # <secret> openssl rand -hex 32
DATABASE_URL=               # <secret> postgres

# Indexer
PONDER_RPC_URL_4663=        # <secret>
PONDER_START_BLOCK=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## BLOCK 2 — `web/.env.local` (local dev of the Next.js app)

```dotenv
# Public client config (safe in the browser bundle)
NEXT_PUBLIC_FACTORY_ADDRESS=0x069974136c78Cf0F2162463B95321E59F56523D8
NEXT_PUBLIC_LENS_ADDRESS=0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770
NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS=0x427764d0d19aB765c35A41A5aa4771580307dA81
NEXT_PUBLIC_V4_HOOK_ADDRESS=0x9C15c992E4De3711715C8B7D717EF46e474680CC
NEXT_PUBLIC_FEE_CONFIG_ADDRESS=          # set once FeeConfig is deployed
NEXT_PUBLIC_WETH_ADDRESS=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
NEXT_PUBLIC_POOL_MANAGER_ADDRESS=0x8366a39CC670B4001A1121B8F6A443A643e40951
NEXT_PUBLIC_STATE_VIEW_ADDRESS=0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
NEXT_PUBLIC_V4_QUOTER_ADDRESS=0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS=0x8876789976dEcBfCbBbe364623C63652db8C0904
NEXT_PUBLIC_ETH_USD_FEED_ADDRESS=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
NEXT_PUBLIC_REOWN_PROJECT_ID=253bb93c024c823876265f33e0546a3f
NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
NEXT_PUBLIC_INDEXER_URL=                 # set once the indexer is deployed
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Server-only (NEVER prefix NEXT_PUBLIC_ — these must not reach the browser)
PINATA_JWT=                              # <secret>
RPC_UPSTREAM_URL=                        # <secret> Alchemy 4663 endpoint
```

## BLOCK 3 — Vercel (project → Settings → Environment Variables)

**Public (`NEXT_PUBLIC_*`) — safe in the client bundle:**
```
NEXT_PUBLIC_FACTORY_ADDRESS=0x069974136c78Cf0F2162463B95321E59F56523D8
NEXT_PUBLIC_LENS_ADDRESS=0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770
NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS=0x427764d0d19aB765c35A41A5aa4771580307dA81
NEXT_PUBLIC_V4_HOOK_ADDRESS=0x9C15c992E4De3711715C8B7D717EF46e474680CC
NEXT_PUBLIC_FEE_CONFIG_ADDRESS=              # set once deployed
NEXT_PUBLIC_WETH_ADDRESS=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
NEXT_PUBLIC_POOL_MANAGER_ADDRESS=0x8366a39CC670B4001A1121B8F6A443A643e40951
NEXT_PUBLIC_STATE_VIEW_ADDRESS=0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
NEXT_PUBLIC_V4_QUOTER_ADDRESS=0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS=0x8876789976dEcBfCbBbe364623C63652db8C0904
NEXT_PUBLIC_ETH_USD_FEED_ADDRESS=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
NEXT_PUBLIC_REOWN_PROJECT_ID=253bb93c024c823876265f33e0546a3f
NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
NEXT_PUBLIC_INDEXER_URL=                     # set once the indexer is deployed
NEXT_PUBLIC_APP_URL=https://ballasted.xyz
```

**Server-only — DO NOT prefix `NEXT_PUBLIC_`:**
```
PINATA_JWT=<secret>
RPC_UPSTREAM_URL=<secret>
```

Do **not** add deploy keys, allowlist pairs, DB, or Ponder vars to Vercel — the web
app never reads them.
