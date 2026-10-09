// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockRamsesV3Pool} from "./MockRamsesV3Pool.sol";

/// @notice Minimal test-only stand-in for Ramses' real V3 Factory — just
///         enough surface (`getPool`/`createPool`) for RamsesLockLauncher's
///         pool-init price-protection logic to exercise against in unit
///         tests. Not vendored, not a real factory — the authoritative proof
///         against the real deployed factory is test/BallastFeeSplitterFork.t.sol.
contract MockRamsesV3Factory {
    mapping(bytes32 => address) public pools;

    error PoolAlreadyExists();

    function _key(address tokenA, address tokenB, int24 tickSpacing) internal pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(token0, token1, tickSpacing));
    }

    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address pool) {
        return pools[_key(tokenA, tokenB, tickSpacing)];
    }

    function createPool(address tokenA, address tokenB, int24 tickSpacing, uint160 sqrtPriceX96)
        external
        returns (address pool)
    {
        bytes32 key = _key(tokenA, tokenB, tickSpacing);
        if (pools[key] != address(0)) revert PoolAlreadyExists();
        int24 tick = 0; // not exercised by the launcher's price-protection logic itself
        pool = address(new MockRamsesV3Pool(sqrtPriceX96, tick));
        pools[key] = pool;
    }

    /// @dev Test-only hook: registers an already-deployed (and possibly
    ///      uninitialized, price == 0) pool directly, bypassing createPool's
    ///      always-initializes behavior -- lets a test reach
    ///      RamsesLockLauncher._ensurePoolPrice's "exists but never
    ///      initialized" branch, which the real factory's createPool can never
    ///      produce (defensive-only in the real contract).
    function forceRegister(address tokenA, address tokenB, int24 tickSpacing, address pool) external {
        pools[_key(tokenA, tokenB, tickSpacing)] = pool;
    }
}
