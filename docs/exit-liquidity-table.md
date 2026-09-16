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

Thresholds used: **GREEN** < 0.5% impact at $10k with a real (non-trivial) route; **AMBER** 0.5–3% at $10k with at least one real fallback route; **RED** > 3% at $10k, OR no viable route to WETH at all regardless of the impact number on whatever route does exist. AMZN is RED on the second clause, not the first — its $1.58% figure alone would read AMBER, but "the only route" is a structural risk a slippage percentage can't capture. MSFT is the one AMBER asset close enough to the RED line that it should not be promoted alongside the others without its own review.

## Recommendation for A1's final step

- **Ship GREEN only for now**: SGOV, NVDA, SPY. These clear $10k trades with room to spare and don't depend on a single route.
- **Hold AMBER** (TSLA, GOOGL, AAPL, META, QQQ) until either (a) their liquidity deepens on its own, or (b) someone runs the real Quoter-simulated version of this table per asset — the estimate here is good enough to triage, not good enough to gate a live contract parameter change on for a launchpad that keeps other people's money in these assets.
- **MSFT specifically**: treat as AMBER-pending-review, not AMBER-same-as-the-rest — re-run its numbers with a real quoter before it's ever bundled into a promotion pass with TSLA/GOOGL/AAPL/META/QQQ.
- **AMZN is RED, not AMBER — do not allowlist it** until a second, independent route to WETH exists. A single-route asset is one pool incident away from holders having no exit at all; that's a structural exclusion, not a liquidity number that might improve on its own schedule.
- **Re-verify the GOOGL address at the allowlist gate every time**, independent of this table — the impostor pool existing at all is a standing reminder that ticker-based resolution is never safe on this chain. See docs/asset-identity.md (or lib/assetIdentity.ts) for the address-first resolver this now feeds.

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
