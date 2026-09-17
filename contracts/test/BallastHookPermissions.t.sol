// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {BallastHook, BALLAST_HOOK_FLAGS} from "../src/BallastHook.sol";
import {FeeConfig} from "../src/FeeConfig.sol";

/// @dev The "address-bitmask" test. BALLAST_HOOK_FLAGS (what every deploy script
///      and fork test mines the hook's address against) and getHookPermissions()
///      (what PoolManager actually enforces at call time, and what HookMiner's
///      own internal check reads) are two SEPARATELY hand-written expressions of
///      the same five permissions. Nothing stops them drifting apart except a
///      test that checks both against a THIRD, independent source — Hooks.sol's
///      own flag constants — rather than one deriving from the other.
///
///      No network needed: this is pure bit arithmetic + a local CREATE2 mine,
///      not a fork test.
contract BallastHookPermissionsTest is Test {
    function _hook() internal returns (BallastHook) {
        FeeConfig cfg = new FeeConfig(address(this), makeAddr("platform"));
        return new BallastHook(IPoolManager(address(1)), cfg, address(2));
    }

    function test_flagsConstant_matchesGetHookPermissions_bitForBit() public {
        BallastHook hook = _hook();
        Hooks.Permissions memory p = hook.getHookPermissions();

        uint160 expected;
        if (p.beforeInitialize) expected |= Hooks.BEFORE_INITIALIZE_FLAG;
        if (p.afterInitialize) expected |= Hooks.AFTER_INITIALIZE_FLAG;
        if (p.beforeAddLiquidity) expected |= Hooks.BEFORE_ADD_LIQUIDITY_FLAG;
        if (p.afterAddLiquidity) expected |= Hooks.AFTER_ADD_LIQUIDITY_FLAG;
        if (p.beforeRemoveLiquidity) expected |= Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        if (p.afterRemoveLiquidity) expected |= Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        if (p.beforeSwap) expected |= Hooks.BEFORE_SWAP_FLAG;
        if (p.afterSwap) expected |= Hooks.AFTER_SWAP_FLAG;
        if (p.beforeDonate) expected |= Hooks.BEFORE_DONATE_FLAG;
        if (p.afterDonate) expected |= Hooks.AFTER_DONATE_FLAG;
        if (p.beforeSwapReturnDelta) expected |= Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterSwapReturnDelta) expected |= Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterAddLiquidityReturnDelta) expected |= Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
        if (p.afterRemoveLiquidityReturnDelta) expected |= Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;

        assertEq(hook.FLAGS(), expected, "FLAGS must exactly equal getHookPermissions()'s bit encoding");
        // Sanity: exactly five bits set (beforeSwap, afterSwap, both returnDelta
        // pairs' before/afterSwap halves, beforeRemoveLiquidity) — catches a
        // stray extra permission slipping into either expression unnoticed.
        assertEq(_popcount(expected), 5, "expected exactly 5 permission bits");
    }

    /// @dev The mined address itself: HookMiner must land on an address whose
    ///      low 14 bits are EXACTLY FLAGS — not a superset (which would let
    ///      PoolManager silently call a permission getHookPermissions() never
    ///      declared) and not a subset (which would silently drop one it did).
    function test_minedAddress_lowBitsExactlyMatchFlags() public {
        FeeConfig cfg = new FeeConfig(address(this), makeAddr("platform"));
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), BALLAST_HOOK_FLAGS, type(BallastHook).creationCode, abi.encode(IPoolManager(address(1)), cfg, address(2))
        );
        BallastHook hook = new BallastHook{salt: salt}(IPoolManager(address(1)), cfg, address(2));
        assertEq(address(hook), hookAddr, "mined salt must produce this exact address");
        assertEq(
            uint160(address(hook)) & Hooks.ALL_HOOK_MASK, BALLAST_HOOK_FLAGS, "low 14 bits must exactly equal FLAGS, no more, no less"
        );
    }

    function _popcount(uint160 x) internal pure returns (uint256 count) {
        while (x != 0) {
            count += x & 1;
            x >>= 1;
        }
    }
}
