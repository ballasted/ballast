// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @dev The BallastHook fee ledger — the platform's WETH fee share accrues here and
///      is pulled with claim() (which pays msg.sender, i.e. this contract).
interface IBallastHookClaim {
    function claim() external returns (uint256);
    function owed(address recipient) external view returns (uint256);
}

/// @title BuybackBurner — spends accrued protocol WETH fees on $BALLAST and burns it
///
/// @notice The platform's share of swap fees (set FeeConfig.platformVault to this
///         contract) accrues as WETH. When the WETH held here reaches `threshold`,
///         ANYONE may call buybackAndBurn(): it claims the WETH, buys $BALLAST on the
///         open market THROUGH THE POOL (a real v4 swap, with price impact, that
///         appears in the trades feed like any other buy), and sends every token
///         bought to a dead address. It is permissionless and threshold-gated, so it
///         is a mechanism rather than a promise that depends on anyone remembering.
///
///         This confers nothing on holders and predicts nothing about price. Burning
///         reduces the circulating supply; what price does is not controlled here.
///
/// @dev Trust properties, by construction:
///      • NO withdrawal path for the accrued WETH or the $BALLAST — the only exit for
///        WETH is buybackAndBurn -> market -> dead address. The owner can retune the
///        threshold and slippage bound, and set which hooks to claim from; it cannot
///        pull the funds out. This is deliberate: the fees fund buybacks, full stop.
///      • $BALLAST has no burn() (immutable ERC-20, mint-once), so "burn" is a
///        transfer to DEAD — irretrievable and independently verifiable on-chain.
///        totalSupply() is therefore unchanged; circulating = totalSupply - DEAD bal.
///      • The buy is a plain poolManager.swap in an unlock callback — it does NOT use
///        the chain's forked UniversalRouter, so none of that fork's encoding applies.
///      • A caller-independent slippage bound (sqrtPrice limit derived from the live
///        price ± maxSlippageBps) caps how far one buyback can move the price, so a
///        permissionless call can't be turned into an unbounded sandwich; unspent
///        WETH (if the limit is hit) simply rolls into the next buyback.
contract BuybackBurner is IUnlockCallback, Ownable2Step, ReentrancyGuard {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice Irretrievable burn address. NOT address(0) — OZ ERC-20 reverts on a
    ///         transfer to the zero address, and a nonzero dead address is what a
    ///         reader can look up a balance for.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000; // 20% hard ceiling on the tunable

    IPoolManager public immutable poolManager;
    address public immutable weth;
    address public immutable ballast; // the $BALLAST token (pool currency0, token < weth)

    /// @notice The $BALLAST/WETH pool this contract buys through (its hook is whatever
    ///         that pool was graduated under — for $BALLAST, a prior hook).
    PoolKey public poolKey;

    /// @notice Hooks whose `owed(this)` we sweep before a buyback — where the platform
    ///         fee share accrues (the current hook, plus any prior hook still owing).
    address[] public claimHooks;

    /// @notice Minimum WETH held before a buyback may run. Retunable by the owner.
    uint256 public threshold;
    /// @notice Max price move one buyback may cause, in bps (caps MEV). Retunable.
    uint16 public maxSlippageBps;

    // Cumulative record for the public page (also fully reconstructable from events).
    uint256 public totalWethSpent;
    uint256 public totalBallastBurned;
    uint256 public buybackCount;

    event BuybackBurned(
        address indexed caller,
        uint256 wethSpent,
        uint256 ballastBought,
        uint256 ballastBurned,
        uint256 totalWethSpent,
        uint256 totalBallastBurned
    );
    event ThresholdSet(uint256 threshold);
    event MaxSlippageSet(uint16 maxSlippageBps);
    event ClaimHooksSet(address[] hooks);

    error BelowThreshold(uint256 held, uint256 threshold);
    error NothingBought();
    error SlippageTooHigh();
    error ZeroAddress();
    error NotPoolManager();

    constructor(
        IPoolManager poolManager_,
        address weth_,
        address ballast_,
        PoolKey memory poolKey_,
        address[] memory claimHooks_,
        uint256 threshold_,
        uint16 maxSlippageBps_,
        address owner_
    ) Ownable(owner_) {
        if (weth_ == address(0) || ballast_ == address(0)) revert ZeroAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        poolManager = poolManager_;
        weth = weth_;
        ballast = ballast_;
        poolKey = poolKey_;
        claimHooks = claimHooks_;
        threshold = threshold_;
        maxSlippageBps = maxSlippageBps_;
    }

    // --------------------------------------------------------------------- //
    //  Owner controls — tuning only, never a way to remove the funds        //
    // --------------------------------------------------------------------- //
    function setThreshold(uint256 threshold_) external onlyOwner {
        threshold = threshold_;
        emit ThresholdSet(threshold_);
    }

    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    function setClaimHooks(address[] calldata hooks) external onlyOwner {
        claimHooks = hooks;
        emit ClaimHooksSet(hooks);
    }

    // --------------------------------------------------------------------- //
    //  Views for the page                                                   //
    // --------------------------------------------------------------------- //

    /// @notice WETH available to a buyback right now: what's held plus what's still
    ///         claimable across the configured hooks.
    function accruedWeth() external view returns (uint256) {
        return _accruedWeth();
    }

    function _accruedWeth() internal view returns (uint256 total) {
        total = IERC20(weth).balanceOf(address(this));
        for (uint256 i; i < claimHooks.length; ++i) {
            total += IBallastHookClaim(claimHooks[i]).owed(address(this));
        }
    }

    function claimHooksLength() external view returns (uint256) {
        return claimHooks.length;
    }

    /// @notice $BALLAST held at the dead address — the independently-verifiable burn
    ///         total. (Equals totalBallastBurned unless someone else also burned.)
    function burnedBalance() external view returns (uint256) {
        return IERC20(ballast).balanceOf(DEAD);
    }

    // --------------------------------------------------------------------- //
    //  Buyback + burn — permissionless, threshold-gated                     //
    // --------------------------------------------------------------------- //
    function buybackAndBurn() external nonReentrant returns (uint256 ballastBurned) {
        // Gate on held + still-claimable WETH, BEFORE touching anything, so a
        // below-threshold call reverts cleanly without moving funds.
        uint256 available = _accruedWeth();
        if (available < threshold) revert BelowThreshold(available, threshold);

        // 1. Sweep claimable WETH from every configured hook into this contract.
        for (uint256 i; i < claimHooks.length; ++i) {
            IBallastHookClaim(claimHooks[i]).claim();
        }
        uint256 wethIn = IERC20(weth).balanceOf(address(this));

        // 2. Swap all held WETH -> $BALLAST through the pool (in the unlock callback).
        uint256 bought = abi.decode(poolManager.unlock(abi.encode(wethIn)), (uint256));
        if (bought == 0) revert NothingBought();

        // 3. Burn: send every token bought to the dead address, irretrievable.
        IERC20(ballast).safeTransfer(DEAD, bought);

        // 4. Record. wethSpent is the amount actually consumed by the swap (unspent
        //    WETH, if the price limit was hit, stays for the next buyback).
        uint256 spent = wethIn - IERC20(weth).balanceOf(address(this));
        totalWethSpent += spent;
        totalBallastBurned += bought;
        buybackCount += 1;
        ballastBurned = bought;

        emit BuybackBurned(msg.sender, spent, bought, bought, totalWethSpent, totalBallastBurned);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 wethIn = abi.decode(data, (uint256));

        PoolKey memory key = poolKey;
        // $BALLAST sorts as currency0 (token < weth), WETH is currency1. Buying
        // $BALLAST with WETH is one-for-zero: zeroForOne = false.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());

        // Caller-independent slippage bound. zeroForOne=false pushes the price UP, so
        // the limit is an upper bound. sqrt scales as sqrt(price), so a maxSlippageBps
        // move on price ≈ half that on sqrtPrice.
        uint256 rawLimit = (uint256(sqrtPriceX96) * (2 * BPS + maxSlippageBps)) / (2 * BPS);
        uint160 maxLimit = TickMath.MAX_SQRT_PRICE - 1;
        uint160 sqrtPriceLimitX96 = rawLimit >= maxLimit ? maxLimit : uint160(rawLimit);

        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(wethIn), // exact-in
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            ""
        );

        // currency1 (WETH) is owed by us (negative); currency0 ($BALLAST) is received.
        int128 d1 = delta.amount1();
        int128 d0 = delta.amount0();
        if (d1 < 0) {
            key.currency1.settle(poolManager, address(this), uint256(uint128(-d1)), false);
        }
        uint256 bought = d0 > 0 ? uint256(uint128(d0)) : 0;
        if (bought > 0) {
            key.currency0.take(poolManager, address(this), bought, false);
        }
        return abi.encode(bought);
    }
}
