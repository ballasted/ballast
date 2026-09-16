// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title OrderingLib — v4 PoolKey currency-ordering, derived per-call instead of
///        guaranteed by construction
///
/// @notice Uniswap v4 requires currency0 < currency1 by address in every PoolKey.
///         Until this workstream, Ballast guaranteed the launched token was always
///         currency0 by CREATE2-mining its address below the single fixed WETH
///         address (see BallastFactory's removed `_mineCurrency0Salt`). That only
///         worked because there was exactly one possible quote asset to mine
///         below — it cannot extend to a per-launch choice among ~11 quote assets,
///         since a token address can't simultaneously sort below all of them.
///
///         This library replaces "guaranteed by mining" with "derived, every time
///         a caller needs to know." Every consumer (BallastSeeder, BallastHook,
///         BallastFactory) should call `sort`/`isZeroForOne` rather than assume a
///         side — that is the whole point of this library existing.
library OrderingLib {
    /// @notice Sort two currencies into v4's required (currency0, currency1)
    ///         order. Reverts on equal addresses — a pool can't pair an asset
    ///         with itself, and silently returning input order for that case
    ///         would hide a caller bug rather than surface it.
    error IdenticalCurrencies();

    function sort(address a, address b) internal pure returns (address currency0, address currency1) {
        if (a == b) revert IdenticalCurrencies();
        return a < b ? (a, b) : (b, a);
    }

    /// @notice True if swapping FROM `input` TO the other currency in a
    ///         (currency0, currency1) pair is zeroForOne (currency0 -> currency1).
    function isZeroForOne(address input, address currency0) internal pure returns (bool) {
        return input == currency0;
    }

    /// @notice True if `token` is currency0 once sorted against `quoteAsset`. The
    ///         one question every current consumer (Seeder's one-sided liquidity
    ///         side, Hook's fee-leg identification) actually needs answered.
    function tokenIsCurrency0(address token, address quoteAsset) internal pure returns (bool) {
        (address currency0,) = sort(token, quoteAsset);
        return currency0 == token;
    }
}
