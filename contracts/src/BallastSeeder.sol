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

/// @title BallastSeeder — seed a token/WETH pool with ONE-SIDED token liquidity
///
/// @notice Direct-seed model: the project's tokens are placed as single-sided
///         liquidity from the backing price (P0) UP to ~1000×P0. The creator
///         supplies only tokens — NO WETH — and buyers' WETH accumulates into the
///         (locked) position. Below P0 there is no protocol liquidity, so the token
///         cannot print below backing at launch (disclosed, not a floor).
///
/// @dev The token MUST sort as currency0 (below WETH), so price = WETH/token and a
///      range ABOVE spot in price is ABOVE spot in ticks — currency0 is the asset
///      provided in an above-spot range, giving a strictly one-sided position that
///      needs no WETH. LP is LOCKED PERMANENTLY: this contract owns the position and
///      exposes NO way to remove liquidity.
contract BallastSeeder is IUnlockCallback {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;
    address public immutable weth;
    address public immutable hook;

    int24 public constant TICK_SPACING = 60;
    // ~1000x span: ln(1000)/ln(1.0001) ≈ 69078 ticks, snapped to spacing.
    int24 public constant RANGE_TICKS = 69060;

    error NotCurrency0();
    error NotPoolManager();
    error NotOneSided();
    error TickMisaligned();

    event Seeded(address indexed token, PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity);

    constructor(IPoolManager poolManager_, address weth_, address hook_) {
        poolManager = poolManager_;
        weth = weth_;
        hook = hook_;
    }

    /// @notice Create the token/WETH pool at P0 = price at `tickLower`, and seed all
    ///         token this contract holds as one-sided liquidity [tickLower, tickLower+RANGE].
    /// @param token project token (must be currency0, i.e. token < weth)
    /// @param tickLower the backing-price tick (P0); must be tick-spacing aligned
    function seed(address token, int24 tickLower) external returns (PoolKey memory key) {
        if (token >= weth) revert NotCurrency0();
        if (tickLower % TICK_SPACING != 0) revert TickMisaligned();

        key = PoolKey({
            currency0: Currency.wrap(token),
            currency1: Currency.wrap(weth),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(tickLower));

        uint256 amount = IERC20(token).balanceOf(address(this));
        poolManager.unlock(abi.encode(key, tickLower, amount));
        return key;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, int24 tickLower, uint256 amount) = abi.decode(data, (PoolKey, int24, uint256));
        int24 tickUpper = tickLower + RANGE_TICKS;

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liq = LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, amount);

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

        // Strictly one-sided: only token (currency0) is owed, never WETH.
        if (delta.amount1() != 0) revert NotOneSided();
        key.currency0.settle(poolManager, address(this), uint256(uint128(-delta.amount0())), false);

        emit Seeded(Currency.unwrap(key.currency0), key, tickLower, tickUpper, liq);
        return "";
    }
}
