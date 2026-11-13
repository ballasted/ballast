// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";
import {OrderingLib} from "../libraries/OrderingLib.sol";

interface IBallastHookV5Init {
    function initPool(PoolKey calldata key, uint16 feeBps) external;
}

/// @title BallastSeederV5 — gen-5 one-sided LP seeder (Elysium)
///
/// @notice Identical one-sided, permanently-locked liquidity model as gen-4's
///         BallastSeeder, with one gen-5 addition: it records the pool's
///         creator-picked swap fee on the hook (hook.initPool) at seed time — the only
///         moment a pool's fee is ever set. LP is LOCKED PERMANENTLY: this contract
///         owns the position and exposes no way to remove liquidity, and the gen-5
///         hook's beforeRemoveLiquidity additionally reverts if the seeder ever tries.
contract BallastSeederV5 is IUnlockCallback {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;
    address public immutable hook;

    int24 public constant TICK_SPACING = 60;
    int24 public constant RANGE_TICKS = 69060; // ~1000x span, snapped to spacing

    error NotPoolManager();
    error NotOneSided();
    error TickMisaligned();

    event Seeded(address indexed token, PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity, uint16 feeBps);

    constructor(IPoolManager poolManager_, address hook_) {
        poolManager = poolManager_;
        hook = hook_;
    }

    /// @notice Initialize the token/quoteAsset pool at `openTick`, record its fee on
    ///         the hook, and seed EXACTLY `amount` of token as one-sided liquidity.
    function seed(address token, address quoteAsset, int24 openTick, uint256 amount, uint16 feeBps)
        external
        returns (PoolKey memory key)
    {
        if (openTick % TICK_SPACING != 0) revert TickMisaligned();

        bool tokenIsCurrency0 = OrderingLib.tokenIsCurrency0(token, quoteAsset);
        (address currency0, address currency1) = OrderingLib.sort(token, quoteAsset);
        key = PoolKey({
            currency0: Currency.wrap(currency0),
            currency1: Currency.wrap(currency1),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(openTick));

        // Write the creator-picked fee ONCE (seeder is the only authorized caller).
        IBallastHookV5Init(hook).initPool(key, feeBps);

        poolManager.unlock(abi.encode(key, token, openTick, amount, tokenIsCurrency0, feeBps));
        return key;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, address token, int24 openTick, uint256 amount, bool tokenIsCurrency0, uint16 feeBps) =
            abi.decode(data, (PoolKey, address, int24, uint256, bool, uint16));

        int24 tickLower;
        int24 tickUpper;
        uint128 liq;
        if (tokenIsCurrency0) {
            tickLower = openTick;
            tickUpper = openTick + RANGE_TICKS;
            liq = LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount
            );
        } else {
            tickLower = openTick - RANGE_TICKS;
            tickUpper = openTick;
            liq = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount
            );
        }

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

        if (tokenIsCurrency0) {
            if (delta.amount1() != 0) revert NotOneSided();
            key.currency0.settle(poolManager, address(this), uint256(uint128(-delta.amount0())), false);
        } else {
            if (delta.amount0() != 0) revert NotOneSided();
            key.currency1.settle(poolManager, address(this), uint256(uint128(-delta.amount1())), false);
        }

        emit Seeded(token, key, tickLower, tickUpper, liq, feeBps);
        return "";
    }
}
