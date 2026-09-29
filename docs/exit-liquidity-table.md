# Exit-liquidity table — the 10 AssetRegistry assets as candidate quote assets

Compiled 2026-09-17 from live GeckoTerminal pool data on Robinhood Chain (network slug `robinhood`), cross-checked against the AssetRegistry addresses actually deployed (`web/scripts/setAssets.ts` / on-chain `AssetRegistry.allowedAssets()`). This gates the final step of A1: lifting `BallastFactory.QuoteAssetNotSupportedYet` for GREEN assets only.

**What this measures**: if a Ballast pool is quoted in `<asset>` instead of WETH, can a holder actually get back to WETH/ETH, and how much does that cost at realistic trade sizes? This is about the ASSET's own external liquidity against WETH (directly, or via USDG as a bridge) — not the Ballast pool itself, which doesn't exist yet for any of these.

**Method**: for each asset, took the deepest of (a) a direct `<asset>/WETH` Uniswap pool, if one exists, and (b) a `<asset>/USDG` pool combined with the very deep `USDG/WETH` market (~$29M combined across fee tiers — its own slippage at $10k is ~0.07%, folded into the estimate as negligible). Price impact is a constant-product estimate — `2 × tradeUSD / reserveUSD`, treating each pool's reported `reserve_in_usd` as a roughly balanced two-sided pool — **not a Quoter-simulated exact figure**. Real v3 concentrated liquidity can be shallower or deeper right at the current tick than this assumes. Treat this table as a triage pass that correctly orders "clearly fine" from "clearly thin," not as a number to hardcode into a contract.

## ⚠️ Finding, not asked for but load-bearing: a fake "GOOGL" pool exists

Searching Uniswap pools by ticker on this chain surfaces a `GOOGL/WETH 0.3%` pool reporting **$6.24 billion** of reserve — obviously fabricated (total volume across every pool on this chain is nowhere near that). Its base token, `0x1d45f0d84b83497874cb38560eb9f6d332a8372b`, **does not match** the real Robinhood GOOGL address in AssetRegistry (`0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3`). This is the exact impostor risk CLAUDE.md rule 14 exists to guard against, now observed for real: a same-ticker, different-contract token with a wash-traded/fabricated pool sitting on the same DEX. The real GOOGL's own liquidity is modest ($1.3–1.5M per pool, see table) and completely unrelated to that $6.24B figure. **Any tooling that resolves a quote asset by searching for a ticker rather than the exact registry address would route through the fake pool.** The existing allowlist-by-address discipline (rule 14) already prevents this for treasury assets; the same must hold with zero exceptions once these become quote-asset candidates too — never resolve a quote asset from a symbol string.

## The table

| Asset | Direct WETH pool | Via-USDG pool (best) | Impact @ $1k | Impact @ $10k | Class | Note |
|---|---|---|---|---|---|---|
| **SGOV** | $141.9K (1%) | **$5.08M** (0.3%) | 0.04% | 0.39% | 🟢 GREEN | Deep via-USDG route; thin direct pool doesn't matter |
| **NVDA** | $1.27M (0.05%) | **$6.72M** (0.05%) | 0.03% | 0.30% | 🟢 GREEN | Deepest of the ten by a clear margin |
| **SPY** | $1.74M (0.05%) | **$8.64M** (0.3%) | 0.02% | 0.23% | 🟢 GREEN | Deepest via-USDG route of all ten |
| **META** | $167.9K (0.3%) | **$1.79M** (0.3%) | 0.11% | 1.11% | 🟡 AMBER | Comfortable at $1k, real impact at $10k |
| **QQQ** | $209.9K (0.3%) | **$1.47M** (0.05%) | 0.14% | 1.36% | 🟡 AMBER | |
| **AAPL** | $187.7K (0.05%) | **$1.48M** (0.3%) | 0.14% | 1.36% | 🟡 AMBER | |
| **GOOGL** | $174.4K (v4) | **$1.50M** (0.3%, real contract) | 0.13% | 1.33% | 🟡 AMBER | Real pool is fine; see the impostor warning above — do not confuse with the $6.24B fake pool |
| **TSLA** | $487.6K (0.3%) | **$1.13M** (0.3%) | 0.18% | 1.77% | 🟡 AMBER | |
| **MSFT** | $67.0K (v4, thinnest direct pool of the ten) | **$768.4K** (0.3%) | 0.26% | 2.60% | 🟡 AMBER — **review before promotion, do not batch with the others** | Shallowest via-USDG route of the ten and closest to the RED line; the estimate's own margin of error (see Method) could put its real impact over 3% |
| **AMZN** | **none found** | **$1.27M** (0.3%) | 0.16% | 1.58% | 🔴 **RED** | **No direct WETH pool at all.** Corrected from an earlier AMBER call: a single route isn't a thin exit, it's the only exit — if AMZN/USDG liquidity thins or that pool is disrupted, there is NO fallback path to WETH, full stop. Held out of the allowlist regardless of how the impact number alone reads. |
| **CRCL** | $335.6K (0.15%, v4 native-ETH) | **$2.01M** (0.3%) | 0.10% | 0.99% | 🟡 AMBER | Deepest via-USDG route of the six batch-2 assets — closer to the GREEN tier than any existing AMBER asset, but still over the 0.5%-at-$10k line. Multiple real fallbacks (a v4 native-ETH pool at $335.6K plus a genuine Uniswap-v3 CRCL/WETH pool at $106.5K, see Raw pool data). |
| **MSTR** | $526.9K (1%) | **$1.59M** (0.25%) | 0.13% | 1.26% | 🟡 AMBER | Direct WETH pool is itself a third of the via-USDG depth — a genuinely usable fallback, not a token one. |
| **PLTR** | $57.3K (0.3%) | **$888.7K** (1%) | 0.23% | 2.25% | 🟡 AMBER | Direct pool is thin relative to the via-USDG route; fallback exists but is materially shallower. |
| **COIN** | $653.9K (0.3%) | **$744.4K** (1%) | 0.27% | 2.69% | 🟡 AMBER — **closest of the batch to the RED line, review before promoting** | Direct WETH and via-USDG pools are nearly the same depth — no single dominant route, but neither is deep individually. |
| **AMD** | $15.1K (0.3%) | **$503.0K** (1%) | 0.40% | 3.98% | 🔴 **RED** | Exceeds the 3%-at-$10k line on its best (via-USDG) route; the direct WETH pool is too thin ($15.1K) to be a real fallback. |
| **ORCL** | $3.1K (5%, v4 native-ETH — negligible) | **$147.0K** (1%) | 1.36% | 13.61% | 🔴 **RED** | Thinnest liquidity of any of the sixteen assets reviewed across both passes. No real ERC20/WETH pool exists at all, and even the best via-USDG route is an order of magnitude too thin. No viable exit route, full stop. |

Thresholds used: **GREEN** < 0.5% impact at $10k with a real (non-trivial) route; **AMBER** 0.5–3% at $10k with at least one real fallback route; **RED** > 3% at $10k, OR no viable route to WETH at all regardless of the impact number on whatever route does exist. AMZN is RED on the second clause, not the first — its $1.58% figure alone would read AMBER, but "the only route" is a structural risk a slippage percentage can't capture. MSFT is the one AMBER asset close enough to the RED line that it should not be promoted alongside the others without its own review.

## Recommendation for A1's final step

- **Ship GREEN only for now**: SGOV, NVDA, SPY. These clear $10k trades with room to spare and don't depend on a single route.
- **Hold AMBER** (TSLA, GOOGL, AAPL, META, QQQ, and now CRCL, MSTR, PLTR, COIN from the batch-2 pass) until either (a) their liquidity deepens on its own, or (b) someone runs the real Quoter-simulated version of this table per asset — the estimate here is good enough to triage, not good enough to gate a live contract parameter change on for a launchpad that keeps other people's money in these assets.
- **MSFT specifically**: treat as AMBER-pending-review, not AMBER-same-as-the-rest — re-run its numbers with a real quoter before it's ever bundled into a promotion pass with TSLA/GOOGL/AAPL/META/QQQ.
- **COIN specifically (batch-2)**: same caveat as MSFT, and if anything closer to the line — 2.69% at $10k is the closest of any AMBER asset (old or new batch) to the 3% RED cutoff. Do not bundle it into a promotion pass with CRCL/MSTR/PLTR without its own re-check.
- **AMZN is RED, not AMBER — do not allowlist it** until a second, independent route to WETH exists. A single-route asset is one pool incident away from holders having no exit at all; that's a structural exclusion, not a liquidity number that might improve on its own schedule.
- **AMD and ORCL (batch-2) are also RED** — do not allowlist either. AMD's best route (via-USDG, $503.0K) already exceeds the 3%-at-$10k line outright, with no meaningful fallback. ORCL is worse: its best route is a thin $147.0K via-USDG pool (13.61% impact at $10k) and it has no real ERC20/WETH pool at all — the thinnest liquidity profile of any asset reviewed in either pass.
- **Re-verify addresses at the allowlist gate every time**, independent of this table — beyond the fabricated $6.24B GOOGL impostor, the batch-2 pass turned up smaller ticker-clone tokens sharing the AMD, MSTR, and CRCL symbols (see Raw pool data) with plausible-looking (if much smaller) reserves. None are fabricated at GOOGL's scale, but the pattern — same ticker, different contract, real-looking pool — recurs every time a search is ticker-based instead of address-based. See docs/asset-identity.md (or lib/assetIdentity.ts) for the address-first resolver this now feeds.

## On-chain enforcement, confirmed

`isGreenQuoteAsset` is enforced inside `BallastFactory.launch()` itself (`if (quoteAsset_ != weth && !isGreenQuoteAsset[quoteAsset_]) revert QuoteAssetNotSupportedYet();`) — a launch attempted against AMZN, MSFT, or any other non-GREEN address reverts on-chain, regardless of what any UI does or doesn't show. Covered by `test_quoteAsset_amberTreasuryAsset_stillReverts` (contracts/test/BallastFactory.t.sol), which launches against a real AssetRegistry treasury asset that is deliberately NOT on the green list and asserts the revert. This is not a UI-only gate that a direct contract call could bypass.

## Raw pool data (for the next pass to sanity-check or supersede)

All reserve figures are GeckoTerminal `reserve_in_usd`, network `robinhood`, captured 2026-09-17. Address column is the pool address, not the token.

```
SGOV  0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5
  SGOV/USDG 0.3%   $5,075,176  0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe
  SGOV/USDG 0.05%  $455,827    0x6ba50150b17ffd0972915aaf04ffd5e8f4fa49b4
  SGOV/USDG 0.01%  $74,243     0x8695820e01903c83ccfc27a0933c9fd69f13cac1
  SGOV/WETH 1%     $141,890    0x7f310e3d05e575bd449e4484ef5da15863ea43b1
  SGOV/USDG 0.038% $55,640     0x2a72510d7d92cc121f9733ab6d14227ef8963cfadf9d40ac574f02e20e6299a8 (v4)

NVDA  0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
  NVDA/USDG 0.05%  $6,719,473  0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3
  NVDA/WETH 0.05%  $1,271,232  0x62ab521f71431f78ac374cdbadc6cda3c8916b6c
  NVDA/WETH 0.3%   $238,434    0xf8996e22ac7a67fae741830ad83b3b4d5e5de203 (ramses-v3)

TSLA  0x322F0929c4625eD5bAd873c95208D54E1c003b2d
  TSLA/USDG 0.3%   $1,129,661  0xf4acdaeeb7022862a763c9b1b885e11191c889e3
  TSLA/WETH 0.3%   $487,587    0xa953ca88ff430e9487c60ca34d757414f4efda07
  TSLA/USDG 0.3% (v4) $897,747 0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e

GOOGL  0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3  (real address — see impostor warning above)
  GOOGL/USDG 0.3% (v4) $1,498,969  0xd4ecb79fdc521d7725d22b33ed43cb4e47aa96bfad76aa29577e3151f723ac5e
  GOOGL/USDG 0.05% $1,306,694  0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7
  GOOGL/WETH (v4)  $174,389    0xf532e8efa77fab323800ddc668fdfa226d7a43dee85ba2ba5f1e525fd1d7f0e1
  IMPOSTOR (different contract 0x1d45f0d84b83497874cb38560eb9f6d332a8372b): GOOGL/WETH 0.3% reporting $6,243,254,371 — NOT this asset

AAPL  0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9
  AAPL/USDG 0.3% (v4) $1,475,861  0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb
  AAPL/USDG 0.05%  $488,016    0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d
  AAPL/WETH 0.05%  $187,690    0x8bb3514e2204e1cdf3ac149efee7ff04d91b719f

MSFT  0xe93237C50D904957Cf27E7B1133b510C669c2e74
  MSFT/USDG 0.3%   $768,369    0xeb60bcd1d920ad6e102690ccfc6fb488899e1510
  MSFT/USDG 0.3% (v4) $427,523  0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579
  WETH/MSFT 1% (v4) $66,976    0x34147f36f89c42a67f77601e612abdb1bd40869e53e8d0edd19705ae0499192d

AMZN  0x12f190a9F9d7D37a250758b26824B97CE941bF54
  AMZN/USDG 0.3%   $1,268,757  0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef
  AMZN/USDG 0.24% (v4) $60,898  0xefc94885c96b02696b9b45de43eeeb8ac53c0199cab42b4daae4911b96fb8825
  no direct AMZN/WETH pool found

META  0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35
  META/USDG 0.3% (v4) $1,794,591  0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36
  META/WETH 0.3%   $167,896    0xa4bdb396a69617eb7f70e2cc1ef526f7340b1b0d
  META/USDG 0.3% (ramses) $79,932  0x960f79d8dfec7f2f0c1b24cdac6bb9df1371c6e2

SPY  0x117cc2133c37B721F49dE2A7a74833232B3B4C0C
  SPY/USDG 0.3% (v4) $8,641,746  0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd
  SPY/WETH 0.05%   $1,744,079  0xddcbba3666f578e3f09516f21ff85bfee859ab5e
  (plus several smaller SPY/USDG and SPY/<other-stock> pools)

QQQ  0xD5f3879160bc7c32ebb4dC785F8a4F505888de68
  QQQ/USDG 0.05%   $1,467,737  0xd60a5d14db690b7afad71f76b108071d7175597d
  QQQ/WETH 0.3%    $209,911    0xa40d00a55d43ba2d188039dcf88bd68f4f133e78

WETH/USDG bridge (used for every via-USDG route above)
  USDG/WETH 0.01% (uniswap-v3) $24,703,548  0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca
  USDG/WETH 0.05% (uniswap-v3) $4,360,794   0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a
  WETH/USDG 0.05% (sushiswap-v3) $1,273,741 
  USDG/WETH 0.3% (uniswap-v3)  $1,492,115
  WETH/USDG 0.01% (ramses-v3)  $674,005
  WETH/USDG 0.05% (up-v3)      $587,507
```

## Batch-2 addition — 6 more sourced/verified assets, reviewed 2026-09-29

Same method, same WETH/USDG bridge market above, live GeckoTerminal pool data captured 2026-09-29. Addresses cross-checked against the exact addresses given for this pass — every pool used below was fetched via GeckoTerminal's per-token `/pools` endpoint keyed on that exact address, then the pool's `base_token`/`quote_token` relationship was checked to confirm the token on the other side of the pair actually resolves to that same address (not just a matching ticker). "USDG" below is the same Global Dollar token used throughout this doc (`0x5fc5360d0400a0fd4f2af552add042d716f1d168`); "WETH" is the same wrapped-ETH token (`0x0bd7d308f8e1639fab988df18a8011f41eacad73`) except where noted "v4 native-ETH" — a Uniswap v4 pool paired against native ETH (currency `0x0`), economically equivalent to WETH (1:1 wrappable) but a different on-chain counterparty than the WETH ERC-20 pools used elsewhere.

```
AMD  0x86923f96303d656e4aa86d9d42d1e57ad2023fdc
  AMD/USDG 1% (v4)      $503,049.47  0xde9f85fdd9e05a943a52f2c69ffafe3064a3287df03d02c9b431bc92d4781274
  AMD/USDG 0.3% (v3)    $207,041.44  0x48d284a2a4d3dc1b3da08231fe44317e7e7aa51f
  AMD/WETH 0.3% (v3)    $15,117.46   0x5ca1b5e6cb510b3bf53e7cd8f7d9b5a71b4a4dc0
  AMD/USDG 1% (v3, thin dup fee tier) $8,668.26  0xd6af1dcb75cdae4f2efc403a58ef023a51edc686
  Ticker clones sharing the "AMD" symbol (NOT this asset, small reserves, not fabricated like GOOGL but same risk pattern): "Advanced Micro Dog" 0x1c2a482970ae6b6e5052a7a184c8aef19e0840be (~$12.0K reserve vs. this AMD), "A MEME DOG" 0x590898a162d39f46f8a27fb855d068d08d6b1e18 (~$60.9K reserve vs. this AMD)

COIN  0x6330d8c3178a418788df01a47479c0ce7ccf450b
  COIN/USDG 1% (v4)     $744,406.02  0x007a13fa152f6dc383cad20a8eaab4e1e2538b606936eae2a424f8aa47d6db31
  COIN/WETH 0.3% (v3)   $653,860.50  0x6707aeac7d0e519b083219d27bb427364363183a
  COIN/WETH 5% (v4 native-ETH) $128,957.06  0xa31885709b0962366fee1e182ef1fbc81f39c150d8694965fdca2f4cd13ccc26
  COIN/USDG 0.25% (v4)  $54,957.18   0xe2e1a0e32205e854525e0fb1d3667a53bd3b4919f032b9bcd2a038b6b6dac314
  COIN/USDG 0.3% (up-v3) $47,738.26  0xf13a2d87e13904e0b38270686d5953a7d8207b91

PLTR  0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a
  PLTR/USDG 1% (v4)     $888,706.35  0xee430ee1003e1985e1828a01b9a20dad67ad4302994fe2abb4a173de4ac54623
  PLTR/USDG 0.3% (v3)   $106,630.75  0x851680416a4f4e1c463d45171d61acddbc8554c0
  PLTR/WETH 0.3% (v3)   $57,279.30   0x61be5bfbaf17ae28bf68006103b2e78fe6112638
  PLTR/USDG 0.15% (v4)  $54,305.20   0xc59eaeda6d1a6f031bc7e1d039772f2d675e7b4de2c8668610f4471bd60b3802

ORCL  0xb0992820e760d836549ba69bc7598b4af75dee03
  ORCL/USDG 1% (v4)     $146,996.27  0xc2ce4784e1e72cf0221b51b30c8aaadf6c0b12863cf03ab3687854fb7b1d850a
  WETH/ORCL 5% (v4 native-ETH) $3,140.02  0xc4521bbf7ce3fc0503375a8c77eb14b70e333e5972783ec1e9760ca26346a1a9
  ORCL/USDG 0.5% (v4)   $1,473.79    0x724e673b41c0cfb00d2c247871f7715c40b69668738d11ca8c704477f4add4e8
  no real ERC20/WETH pool found — every other ORCL pool reports under $7K, mostly thin memecoin-paired pools

MSTR  0xec262a75e413fafd0df80480274532c79d42da09
  MSTR/USDG 0.25% (v4)  $1,589,622.39 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe
  MSTR/USDG 0.24% (v4)  $873,808.30  0xc105b8300ff65d750a0e4e63c7a879e20504069b770713464a5315e797735326
  MSTR/WETH 1% (v3)     $526,925.01  0x70504a6fafdbfb75fe971faa4dd716e79ac5624c
  MSTR/USDG 1% (v3)     $525,434.65  0x17578c0e0d15da44f31677263114f71ae76653ea
  MSTR/WETH 0.25% (v4 native-ETH) $126,797.94  0x1dae69f15c48eef452c79360cc8df58f5d5c3c1e6324ff8777d58c1feb053cdc
  Ticker clone: "MSTR / MSTR" pool with counter-side address 0x0655223d8f280bb01fb8b30e98435bb347f6e490 reporting $42,589.30 — NOT this asset

CRCL  0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5
  CRCL/USDG 0.3% (v3)   $2,011,401.03 0x654e4143e82a5824445ade0824351c2a9acd95a8
  CRCL/USDG (v4)        $518,603.98  0xdb9c34002d173981250969293af6f43f42a26f2110f19893bbe2ad373375e9e6
  CRCL/WETH 0.15% (v4 native-ETH) $335,619.63  0x6d9af55c4cb0d740dc5237e8fe2d60e017412fb1af4e2d81e948124797e56748
  CRCL/WETH 0.8% (v4 native-ETH) $121,620.43  0xc73a455650cc4ed91c893d5b26ea79a5278fbf77a7775282c6a190b635e554ee
  CRCL/WETH 1% (v3)     $106,517.06  0x754ddd4bf8e8635b4301a7f4af2ea7a82ab6cea7
  Ticker clones: "CRCL / CRCL" pools with counter-side addresses 0x37144e56f481e23a5a1ebf2c4ff0a82408441e18 (~$31.5K reserve) and 0x51d1abab4d1e7b50642a25d3f7b2823067ebf9d7 (~$13.5K reserve) — NOT this asset
```

## Batch-2 router compatibility

`BallastRouter` (gen-4, deployed 2026-09-26, `0xc422e0a6ca75d1ffafd77f72b710b2ef3aef50e1`; source `contracts/src/BallastRouter.sol`) has a structural property that matters here: **leg 1 (`_swapDirect`) is single-hop only.** It swaps `tokenIn` for `quoteAsset` through exactly one pool taken from the constructor-fixed `routes` array, using the Uniswap-v3-style `swap()` / `uniswapV3SwapCallback()` ABI — the contract's own NatSpec says this is shared by "Uniswap v3 / Ramses v3 — identical swap/callback ABI" and nothing else. Leg 1 never chains through an intermediate token (no WETH→USDG→asset hop), and it cannot call a Uniswap v4 pool at all in that leg (v4 is only used in leg 2, always against the fixed UniversalRouter, with completely different calldata — see `_swapBallastPool`). So router compatibility for a WETH holder depends on one thing only: **does a direct WETH↔asset pool exist, and is it Uniswap v3 or Ramses v3?** The deep via-USDG bridge routes that drive this table's AMBER/GREEN classification are irrelevant to the router — it structurally cannot reach them.

Of the six batch-2 assets, only CRCL, MSTR, PLTR, and COIN classify AMBER (AMD and ORCL are RED, out of scope for "should this become a quote asset" — noted briefly at the end anyway):

- **CRCL** — router-compatible, **no new code needed**. A real, correctly-addressed CRCL/WETH pool exists on Uniswap v3 (1% fee, $106,517 reserve, pool `0x754ddd4bf8e8635b4301a7f4af2ea7a82ab6cea7`) — exactly the ABI leg 1 already calls; adding it is a `routes` entry at the next redeploy, not a logic change. Caveat: CRCL's single deepest WETH-adjacent pool is actually a Uniswap v4 native-ETH pool ($335,619, 0.15% fee) — that one the router cannot reach without new v4-aware leg-1 code, so the best real route today is the shallower v3 one.
- **MSTR** — router-compatible, **no new code needed**. Real MSTR/WETH pool on Uniswap v3 (1% fee, $526,925 reserve, pool `0x70504a6fafdbfb75fe971faa4dd716e79ac5624c`). This happens to be the second-deepest MSTR pool overall (behind only the v4 via-USDG route), so it's a genuinely usable route, not a token one.
- **PLTR** — router-compatible, **no new code needed**, but thin. Real PLTR/WETH pool on Uniswap v3 (0.3% fee, $57,279 reserve, pool `0x61be5bfbaf17ae28bf68006103b2e78fe6112638`). It works today with a routes entry, but a buyer routed through it sees meaningfully worse slippage than this table's AMBER classification implies, because that classification is computed from the $888.7K via-USDG route, which leg 1 cannot reach.
- **COIN** — router-compatible, **no new code needed**, and the best-matched of the four: the real COIN/WETH pool on Uniswap v3 (0.3% fee, $653,860 reserve, pool `0x6707aeac7d0e519b083219d27bb427364363183a`) is nearly as deep as the via-USDG route used for classification ($744,406). Of the four AMBER assets, COIN is the one where the router's actually-reachable liquidity is closest to the table's headline number.
- **AMD / ORCL (RED, for completeness)** — AMD's only direct WETH pool is v3-style and would be router-compatible in protocol terms, but it's far too thin ($15,117) to matter. ORCL has no real ERC20/WETH pool at all — only a negligible native-ETH v4 pool ($3,140) the router can't reach regardless.

**Bottom line**: BallastRouter needs zero new code to route a WETH holder into any of the four AMBER batch-2 assets — each has a real, correctly-addressed Uniswap v3 pool against WETH. What's needed is (a) a `routes` entry per asset added at the next router redeploy (`routes` is constructor-fixed and immutable, so this is a redeploy, not a live config change — same as every existing route), and (b) awareness that for PLTR, and to a lesser extent COIN, the pool the router can actually reach is shallower than the pool this table's classification number is based on, because leg 1 cannot chain through the USDG bridge or call a v4 pool.
