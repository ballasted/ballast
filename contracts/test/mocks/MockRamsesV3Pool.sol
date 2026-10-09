// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal test-only stand-in for a Ramses V3 pool — just enough
///         surface (`slot0`/`initialize`) for RamsesLockLauncher's pool-init
///         price-protection logic to exercise against in unit tests. Not
///         vendored, not a V3 math implementation — the authoritative proof
///         against the real deployed pool is test/BallastFeeSplitterFork.t.sol.
contract MockRamsesV3Pool {
    uint160 public sqrtPriceX96;
    int24 public tick;

    error AlreadyInitialized();

    constructor(uint160 sqrtPriceX96_, int24 tick_) {
        sqrtPriceX96 = sqrtPriceX96_;
        tick = tick_;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96_,
            int24 tick_,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint24 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, tick, 0, 0, 0, 0, true);
    }

    function initialize(uint160 sqrtPriceX96_) external {
        if (sqrtPriceX96 != 0) revert AlreadyInitialized();
        sqrtPriceX96 = sqrtPriceX96_;
    }

    /// @dev Test-only hook — lets a test simulate a front-runner/trade moving
    ///      the price after creation, not part of the real pool's interface.
    function setPrice(uint160 sqrtPriceX96_, int24 tick_) external {
        sqrtPriceX96 = sqrtPriceX96_;
        tick = tick_;
    }
}
