// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @dev Minimal interface onto BallastHook's legacy WETH fee ledger — the platform's
///      hook-fee share (FeeConfig.platformVault) accrues here and is pulled with
///      claim() (which pays msg.sender, i.e. this contract, once platformVault is
///      pointed at it). Same two selectors BuybackBurner (v1) already depends on;
///      see BallastHook.sol: "owed is the pre-existing WETH-only ledger ... must
///      never be touched."
interface IBallastHookClaim {
    function claim() external returns (uint256);
    function owed(address recipient) external view returns (uint256);
}

/// @title BuybackBurnerV2 — permissionless, ownerless buyback-and-burn for $BALLAST v2
///
/// @notice Funded two ways:
///         1. The platform's 20% hook-fee share, across EVERY pool this chain's
///            singleton BallastHook serves (FeeConfig.platformVault pointed at this
///            contract) — pulled permissionlessly via `claimFees`/`claimHooks` (2026-10-06
///            addition, mirrors BuybackBurner v1's claimHooks array, minus the owner).
///         2. $BALLAST v2's OWN creator fee recipient is the Safe (immutable, set at
///            launch — see BallastFactory.sol:367), so the Safe periodically sends a
///            share of what it separately claims as creator (WETH and/or NVDA — v2
///            graduated two pools) here as a documented, manual top-up (see
///            docs/BALLAST_STATE.md). This path is unchanged and still works exactly
///            as before.
///         Once here, funds can ONLY leave via `buybackAndBurn`: swap into $BALLAST v2
///         through its matching pool (the WETH-quoted pool for WETH, the NVDA-quoted
///         pool for NVDA) and send every token bought to the dead address. No owner, no
///         admin function, no withdrawal path of any kind — every parameter below is
///         immutable forever, including `claimHooks` itself (set once at construction,
///         no setter exists).
///
/// @dev Three independent safety bounds, all immutable, all enforced together (not
///      alternatives to each other):
///      1. `maxWethPerCall` / `maxNvdaPerCall` — hard per-call spend ceiling, per asset.
///         A large balance must be drained across multiple calls, never one.
///      2. `cooldownSeconds` — minimum gap between two calls buying with the SAME
///         asset. Combined with (1), this bounds total extractable value from
///         repeated same-block-adjacent MEV to `maxPerCall` every `cooldownSeconds`,
///         not the whole balance at once.
///      3. `minAmountOut` (caller-supplied) capped by `maxSlippageBps` (immutable,
///         checked against the pool's OWN spot price at execution) — the caller
///         (a keeper/UI) is expected to fetch a fresh quote via V4Quoter off-chain
///         and pass its own `minAmountOut`; the contract independently refuses to
///         execute at a price worse than `maxSlippageBps` off current spot regardless
///         of what the caller passes, so a lenient/zero `minAmountOut` from a naive
///         caller can't be combined with a manipulated spot price to drain more than
///         the slippage ceiling allows.
///      This chain has no native TWAP oracle for v4 pools (no oracle-observing hook
///      deployed for these pools), so this is deliberately NOT a TWAP bound — it is
///      the same caller-quote + spot-relative-ceiling combination BuybackBurner (v1)
///      already uses in production, applied per-asset here.
contract BuybackBurnerV2 is IUnlockCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000; // 20% hard ceiling, same as v1

    IPoolManager public immutable poolManager;
    address public immutable ballast; // $BALLAST v2
    address public immutable weth;
    address public immutable nvda;

    /// @notice quote-asset -> BALLAST pools. In BOTH of v2's real pools the quote
    ///         asset (WETH or NVDA) sorts as currency0 and BALLAST as currency1
    ///         (verified live on-chain via StateView.getSlot0 before writing this
    ///         contract, not assumed from v1's opposite ordering).
    PoolKey public wethPoolKey;
    PoolKey public nvdaPoolKey;

    uint256 public immutable maxWethPerCall;
    uint256 public immutable maxNvdaPerCall;
    uint256 public immutable cooldownSeconds;
    uint16 public immutable maxSlippageBps;

    /// @notice Hooks whose `owed(address(this))` WETH this contract pulls before a
    ///         WETH buyback. Set ONCE at construction; no setter exists (every other
    ///         parameter here is the same way) — mirrors BuybackBurner (v1)'s
    ///         `claimHooks` array, minus the owner-settable part. Empty by default
    ///         behavior if deployed with a zero-length array: `claimFees` is then a
    ///         permissionless no-op and buybacks only ever spend whatever WETH/NVDA
    ///         was sent here directly (path 2 in the contract-level note above) —
    ///         i.e. this feature is additive, never required for the contract to work.
    address[] public claimHooks;

    mapping(address => uint256) public lastBuybackAt; // per quote-asset
    mapping(address => uint256) public totalSpent; // per quote-asset
    uint256 public totalBallastBurned;
    uint256 public buybackCount;

    event FeesClaimed(address indexed hook, uint256 amount);
    event BuybackBurned(
        address indexed caller,
        address indexed asset,
        uint256 spent,
        uint256 ballastBought,
        uint256 totalBallastBurned
    );

    error UnsupportedAsset();
    error Cooldown(uint256 readyAt);
    error NothingToSpend();
    error NothingBought();
    error SlippageTooHigh();
    error MinAmountOutNotMet(uint256 got, uint256 wanted);
    error ZeroAddress();
    error ZeroValue();
    error NotPoolManager();

    constructor(
        IPoolManager poolManager_,
        address ballast_,
        address weth_,
        address nvda_,
        PoolKey memory wethPoolKey_,
        PoolKey memory nvdaPoolKey_,
        uint256 maxWethPerCall_,
        uint256 maxNvdaPerCall_,
        uint256 cooldownSeconds_,
        uint16 maxSlippageBps_,
        address[] memory claimHooks_
    ) {
        if (ballast_ == address(0) || weth_ == address(0) || nvda_ == address(0)) revert ZeroAddress();
        if (maxWethPerCall_ == 0 || maxNvdaPerCall_ == 0 || cooldownSeconds_ == 0) revert ZeroValue();
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        for (uint256 i; i < claimHooks_.length; ++i) {
            if (claimHooks_[i] == address(0)) revert ZeroAddress();
        }
        poolManager = poolManager_;
        ballast = ballast_;
        weth = weth_;
        nvda = nvda_;
        wethPoolKey = wethPoolKey_;
        nvdaPoolKey = nvdaPoolKey_;
        maxWethPerCall = maxWethPerCall_;
        maxNvdaPerCall = maxNvdaPerCall_;
        cooldownSeconds = cooldownSeconds_;
        maxSlippageBps = maxSlippageBps_;
        claimHooks = claimHooks_;
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                 //
    // --------------------------------------------------------------------- //

    function burnedBalance() external view returns (uint256) {
        return IERC20(ballast).balanceOf(DEAD);
    }

    function readyAt(address asset) external view returns (uint256) {
        return lastBuybackAt[asset] == 0 ? 0 : lastBuybackAt[asset] + cooldownSeconds;
    }

    function claimHooksLength() external view returns (uint256) {
        return claimHooks.length;
    }

    /// @notice WETH available to a WETH buyback right now: what's held plus what's
    ///         still claimable across `claimHooks`. (NVDA has no claim path — see
    ///         the contract-level note.)
    function accruedWeth() external view returns (uint256 total) {
        total = IERC20(weth).balanceOf(address(this));
        for (uint256 i; i < claimHooks.length; ++i) {
            total += IBallastHookClaim(claimHooks[i]).owed(address(this));
        }
    }

    // --------------------------------------------------------------------- //
    //  Fee claiming — permissionless pull from the configured hooks          //
    // --------------------------------------------------------------------- //

    /// @notice Pull this contract's accrued WETH fee share from every configured
    ///         hook. Permissionless (anyone may call; it only ever moves WETH INTO
    ///         this contract, never out) and a no-op if `claimHooks` is empty or
    ///         nothing is owed. Also called automatically at the start of a WETH
    ///         `buybackAndBurn`, so a single call funds and executes a buyback —
    ///         exposed standalone too for off-chain accounting / pre-funding.
    function claimFees() external nonReentrant returns (uint256) {
        return _claimFees();
    }

    function _claimFees() internal returns (uint256 claimed) {
        for (uint256 i; i < claimHooks.length; ++i) {
            address hook = claimHooks[i];
            if (IBallastHookClaim(hook).owed(address(this)) == 0) continue;
            uint256 got = IBallastHookClaim(hook).claim();
            if (got == 0) continue;
            claimed += got;
            emit FeesClaimed(hook, got);
        }
    }

    // --------------------------------------------------------------------- //
    //  Buyback + burn — permissionless, no owner, ever                      //
    // --------------------------------------------------------------------- //

    /// @param asset Must be `weth` or `nvda`.
    /// @param amountIn Requested spend; clamped to both the held balance and this
    ///        asset's immutable per-call cap.
    /// @param minAmountOut Caller-supplied floor (fetch a fresh V4Quoter quote
    ///        off-chain and pass it here) — reverts if the actual swap output is
    ///        below it, same as a normal DEX slippage parameter.
    function buybackAndBurn(address asset, uint256 amountIn, uint256 minAmountOut)
        external
        nonReentrant
        returns (uint256 ballastBought)
    {
        bool isWeth = asset == weth;
        bool isNvda = asset == nvda;
        if (!isWeth && !isNvda) revert UnsupportedAsset();

        uint256 cap = isWeth ? maxWethPerCall : maxNvdaPerCall;
        uint256 ready = lastBuybackAt[asset] == 0 ? 0 : lastBuybackAt[asset] + cooldownSeconds;
        if (block.timestamp < ready) revert Cooldown(ready);

        // Pull any accrued platform-share WETH before sizing the spend, so a
        // single permissionless call both funds and executes the buyback — no
        // separate claim step and no keeper required.
        if (isWeth) _claimFees();

        uint256 held = IERC20(asset).balanceOf(address(this));
        uint256 spend = amountIn > cap ? cap : amountIn;
        if (spend > held) spend = held;
        if (spend == 0) revert NothingToSpend();

        // Effects before interactions (CEI) — cooldown starts now regardless of
        // how the swap below resolves, so a revert can't be used to bypass it
        // by retrying immediately (a reverted call still consumed a block).
        lastBuybackAt[asset] = block.timestamp;

        PoolKey memory key = isWeth ? wethPoolKey : nvdaPoolKey;
        ballastBought = abi.decode(poolManager.unlock(abi.encode(key, asset, spend)), (uint256));
        if (ballastBought == 0) revert NothingBought();
        if (ballastBought < minAmountOut) revert MinAmountOutNotMet(ballastBought, minAmountOut);

        IERC20(ballast).safeTransfer(DEAD, ballastBought);

        totalSpent[asset] += spend;
        totalBallastBurned += ballastBought;
        buybackCount += 1;

        emit BuybackBurned(msg.sender, asset, spend, ballastBought, totalBallastBurned);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, address asset, uint256 amountIn) = abi.decode(data, (PoolKey, address, uint256));

        // Quote asset (WETH or NVDA) is ALWAYS currency0 in both v2 pools (verified
        // on-chain before deploy — see the contract-level note above); BALLAST is
        // always currency1. Spending currency0 for currency1 is zeroForOne = true,
        // the opposite of v1's BuybackBurner (where the token being bought was
        // currency0). Getting this backwards would either revert or, worse, buy
        // the WRONG side — asserted defensively below, not just commented.
        require(Currency.unwrap(key.currency0) == asset, "asset must be currency0");
        require(Currency.unwrap(key.currency1) == ballast, "ballast must be currency1");

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());

        // Same caller-independent slippage bound as v1: zeroForOne=true pushes the
        // price DOWN (currency0 gets cheaper relative to currency1 as more currency0
        // is sold in), so the limit is a LOWER bound this time (opposite direction
        // from v1's upper bound, because the swap direction is reversed).
        uint256 rawLimit = (uint256(sqrtPriceX96) * (2 * BPS - maxSlippageBps)) / (2 * BPS);
        uint160 minLimit = TickMath.MIN_SQRT_PRICE + 1;
        uint160 sqrtPriceLimitX96 = rawLimit <= minLimit ? minLimit : uint160(rawLimit);

        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: sqrtPriceLimitX96}),
            ""
        );

        // currency0 (the quote asset) is owed by us (negative); currency1 (BALLAST) is received.
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) {
            key.currency0.settle(poolManager, address(this), uint256(uint128(-d0)), false);
        }
        uint256 bought = d1 > 0 ? uint256(uint128(d1)) : 0;
        if (bought > 0) {
            key.currency1.take(poolManager, address(this), bought, false);
        }
        return abi.encode(bought);
    }
}
