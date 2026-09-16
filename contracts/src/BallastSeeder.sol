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
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {OrderingLib} from "./libraries/OrderingLib.sol";

/// @title BallastSeeder — seed a token/quote pool with ONE-SIDED token liquidity
///
/// @notice Direct-seed model: the project's tokens are placed as single-sided
///         liquidity from the backing price (P0) UP to ~1000×P0 real price. The
///         creator supplies only tokens — never the quote asset — and buyers'
///         quote-asset payments accumulate into the (locked) position. Below P0
///         there is no protocol liquidity, so the token cannot print below
///         backing at launch (disclosed, not a floor).
///
/// @dev v4 requires currency0 < currency1 by address, and the launched token's
///      address is no longer mined to guarantee it sorts below the quote asset
///      (see OrderingLib) — a token can land on EITHER side. `openTick` (from
///      BackingMath.p0Tick) is always the tick AT true backing, already
///      correctly rounded for whichever ordering this pool has; this contract
///      mirrors the one-sided range and the amount0-vs-amount1 liquidity math
///      around that ordering so both cases produce an equally one-sided,
///      quote-asset-free position:
///        - token = currency0: real price = currency1/currency0 directly, so
///          "P0 up to 1000xP0" is the range [openTick, openTick+RANGE] — ABOVE
///          the opening tick — held entirely in currency0 (token).
///        - token = currency1: real price = currency0/currency1, the INVERSE of
///          the raw tick, so the same real-price range is [openTick-RANGE,
///          openTick] — BELOW the opening tick — held entirely in currency1
///          (token).
///      LP is LOCKED PERMANENTLY: this contract owns the position and exposes
///      NO way to remove liquidity.
contract BallastSeeder is IUnlockCallback {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;
    address public immutable weth;
    address public immutable hook;

    int24 public constant TICK_SPACING = 60;
    // ~1000x span: ln(1000)/ln(1.0001) ≈ 69078 ticks, snapped to spacing.
    int24 public constant RANGE_TICKS = 69060;

    error NotPoolManager();
    error NotOneSided();
    error TickMisaligned();

    event Seeded(address indexed token, PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity);

    constructor(IPoolManager poolManager_, address weth_, address hook_) {
        poolManager = poolManager_;
        weth = weth_;
        hook = hook_;
    }

    /// @notice Create the token/WETH pool at `openTick` (the backing-price tick,
    ///         already ordering-correct — see BackingMath.p0Tick) and seed all
    ///         token this contract holds as one-sided liquidity around it.
    /// @param token project token — may sort as currency0 or currency1 vs weth
    /// @param openTick the tick AT true backing; must be tick-spacing aligned
    function seed(address token, int24 openTick) external returns (PoolKey memory key) {
        if (openTick % TICK_SPACING != 0) revert TickMisaligned();

        bool tokenIsCurrency0 = OrderingLib.tokenIsCurrency0(token, weth);
        (address currency0, address currency1) = OrderingLib.sort(token, weth);
        key = PoolKey({
            currency0: Currency.wrap(currency0),
            currency1: Currency.wrap(currency1),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(openTick));

        uint256 amount = IERC20(token).balanceOf(address(this));
        poolManager.unlock(abi.encode(key, token, openTick, amount, tokenIsCurrency0));
        return key;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, address token, int24 openTick, uint256 amount, bool tokenIsCurrency0) =
            abi.decode(data, (PoolKey, address, int24, uint256, bool));

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

        // Strictly one-sided: only the token side is ever owed.
        if (tokenIsCurrency0) {
            if (delta.amount1() != 0) revert NotOneSided();
            key.currency0.settle(poolManager, address(this), uint256(uint128(-delta.amount0())), false);
        } else {
            if (delta.amount0() != 0) revert NotOneSided();
            key.currency1.settle(poolManager, address(this), uint256(uint128(-delta.amount1())), false);
        }

        emit Seeded(token, key, tickLower, tickUpper, liq);
        return "";
    }
}
