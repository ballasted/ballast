// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";

/// @notice TEST-ONLY HELPER — never deployed to mainnet, never referenced by
///         any production contract or script. Seeds a plain, two-sided,
///         hookless v4 pool with real liquidity on a mainnet FORK, for fork
///         tests that need a real pool to swap through without touching
///         AssetRegistry (never redeployed/reconfigured — CLAUDE.md hard
///         rules) or impersonating any privileged account (its real owner is
///         the compromised deployer — never used, not even for a local-only
///         `vm.prank`). The pool's price is an arbitrary 1:1 in raw units;
///         these tests assert the pipeline (swap → deposit → BackingLens),
///         never a real-world dollar figure.
///
///         Caller must fund THIS CONTRACT's own balance of both tokens before
///         calling `seed` (typically via forge-std's `deal()` cheatcode,
///         which the existing fork suite already proves works against real
///         Robinhood stock tokens — see BuybackBurnerV2Fork.t.sol,
///         BallastRouterFork.t.sol) — `modifyLiquidity`'s settle pulls from
///         this contract's own balance, the same pattern BallastSeeder uses.
contract TestPoolSeeder is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;

    error NotPoolManager();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function seed(
        address tokenA,
        address tokenB,
        uint24 fee,
        int24 tickSpacing,
        int24 range,
        uint256 amountA,
        uint256 amountB
    ) external returns (PoolKey memory key) {
        bool aIsC0 = tokenA < tokenB;
        address c0 = aIsC0 ? tokenA : tokenB;
        address c1 = aIsC0 ? tokenB : tokenA;
        uint256 amt0 = aIsC0 ? amountA : amountB;
        uint256 amt1 = aIsC0 ? amountB : amountA;

        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(0))
        });
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        int24 aligned = (range / tickSpacing) * tickSpacing;
        poolManager.unlock(abi.encode(key, -aligned, aligned, amt0, amt1, c0, c1));
        return key;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 amt0, uint256 amt1, address c0, address c1) =
            abi.decode(data, (PoolKey, int24, int24, uint256, uint256, address, address));

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            TickMath.getSqrtPriceAtTick(0),
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amt0,
            amt1
        );

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liq)),
                salt: 0
            }),
            ""
        );

        if (delta.amount0() < 0) {
            Currency.wrap(c0).settle(poolManager, address(this), uint256(uint128(-delta.amount0())), false);
        }
        if (delta.amount1() < 0) {
            Currency.wrap(c1).settle(poolManager, address(this), uint256(uint128(-delta.amount1())), false);
        }

        return "";
    }
}
