// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Forces forge to compile the v4-core 0.8.26 contracts the gen-5 (0.8.28) tests deploy
// via `vm.deployCode(...)`. These cannot be imported into a 0.8.28 test directly (exact
// pragma mismatch), so this shim's mere presence in the project keeps their artifacts in
// out/ for deployCode to load by name. Not imported anywhere — compiled for side effect.

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
// Read-side lens contracts the TESTNET self-deploy (script/DeployElysiumV4.s.sol) loads
// via deployCode. ^0.8.0 periphery; they import only the v4-core IPoolManager interface,
// so referencing them here does NOT pull a second concrete PoolManager artifact (which
// would make the deployCode("PoolManager.sol:PoolManager") above ambiguous).
import {StateView} from "v4-periphery/src/lens/StateView.sol";
import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";

contract _V4Artifacts {
    /// Referencing creationCode forces forge to emit full bytecode artifacts for these
    /// contracts, so the 0.8.28 gen-5 tests + testnet deploy script can load them by name
    /// via deployCode.
    function _refs()
        external
        pure
        returns (bytes memory, bytes memory, bytes memory, bytes memory, bytes memory)
    {
        return (
            type(PoolManager).creationCode,
            type(PoolSwapTest).creationCode,
            type(PoolModifyLiquidityTest).creationCode,
            type(StateView).creationCode,
            type(V4Quoter).creationCode
        );
    }
}
