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
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {HolderStakingVault} from "../HolderStakingVault.sol";

interface IGen5HookClaim {
    function claim(address currency) external returns (uint256);
    function owed(address recipient, address currency) external view returns (uint256);
}

interface IFactoryV5Graduated {
    function graduated(address token) external view returns (bool);
}

interface ITokenV5 {
    function creator() external view returns (address);
    function setMetadataURI(string calldata newURI) external;
}

/// @title FeeRouterV5 — one per gen-5 token, WHYPE-denominated (Elysium)
///
/// @notice Receives the 80% creator-side of every gen-5 swap fee (the hook credits
///         THIS contract, as the token's on-chain creator, in WHYPE) and splits it
///         across three buckets under the SAME rules as FeeRouterV2:
///           (a) the creator wallet,
///           (b) bought back and burned (WHYPE -> token -> 0xdead),
///           (c) streamed to opt-in stakers (HolderStakingVault).
///         The treasury and parent-burn buckets of V2 are intentionally absent — there
///         are no price feeds or treasury on Elysium (treasury is feature-flagged off).
///
///         Split rules (identical to V2): the launch split is active from block one;
///         a change that only LOWERS the creator's own share (every other bucket
///         up-or-equal) applies instantly; anything else waits a fixed 7 days.
///
/// @dev One instance per token (the hook's `owed` ledger is keyed by recipient, so a
///      shared router would commingle fees). The only privileged address is
///      `realCreator`; route()/applySplit()/wireBuybackPool()/flushDeferredBuyback()
///      are permissionless. No owner, admin, upgrade, or pause.
contract FeeRouterV5 is IUnlockCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;
    uint256 internal constant SPLIT_DELAY = 7 days;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    int24 internal constant TICK_SPACING = 60;

    address public immutable realCreator;
    address public immutable deployer; // factory, may call initToken once
    address public immutable factory;
    address public immutable hook;
    address public immutable whype; // base pair (replaces WETH)
    IPoolManager public immutable poolManager;
    uint16 public immutable maxSlippageBps;
    uint256 public immutable maxRoutePerCall;
    uint256 public immutable routeCooldown;

    bool public wired;
    address public token;
    address public stakingVault;

    bool public buybackWired;
    PoolKey internal _buybackPoolKey;
    uint256 public pendingBuybackWhype;

    uint16 public creatorBps = BPS;
    uint16 public buybackBps;
    uint16 public rewardsBps;

    bool public hasPendingSplit;
    uint16 public pendingCreatorBps;
    uint16 public pendingBuybackBps;
    uint16 public pendingRewardsBps;
    uint64 public pendingEffectiveAt;

    uint256 public lastRouteAt;
    uint256 public totalRoutedToCreator;
    uint256 public totalRoutedToBuyback;
    uint256 public totalTokenBurned;
    uint256 public totalRoutedToRewards;

    event Wired(address indexed token, address stakingVault);
    event BuybackWired(address currency0, address currency1);
    event SplitScheduled(uint16 creatorBps, uint16 buybackBps, uint16 rewardsBps, uint64 effectiveAt);
    event SplitApplied(uint16 creatorBps, uint16 buybackBps, uint16 rewardsBps);
    event SplitAppliedInstant(uint16 creatorBps, uint16 buybackBps, uint16 rewardsBps, bool cancelledPending);
    event Routed(address indexed caller, uint256 total, uint256 toCreator, uint256 toBuyback, uint256 toRewards);
    event RoutedToBuyback(uint256 whypeIn, uint256 tokenBought);
    event BuybackDeferred(uint256 whypeIn);
    event RoutedToRewards(uint256 amount);

    error ZeroAddress();
    error NotRealCreator();
    error NotAuthorized();
    error AlreadyWired();
    error NotWired();
    error NotGraduated();
    error BuybackNotWired();
    error BadSplit();
    error Cooldown(uint256 readyAt);
    error NothingToRoute();
    error NotPoolManager();
    error MinAmountOutNotMet(uint256 got, uint256 wanted);

    modifier onlyRealCreator() {
        if (msg.sender != realCreator) revert NotRealCreator();
        _;
    }

    constructor(
        address realCreator_,
        address factory_,
        address hook_,
        address whype_,
        address poolManager_,
        uint16 maxSlippageBps_,
        uint256 maxRoutePerCall_,
        uint256 routeCooldown_,
        uint16 initialCreatorBps_,
        uint16 initialBuybackBps_,
        uint16 initialRewardsBps_
    ) {
        if (
            realCreator_ == address(0) || factory_ == address(0) || hook_ == address(0) || whype_ == address(0)
                || poolManager_ == address(0)
        ) revert ZeroAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS) revert BadSplit();
        if (maxRoutePerCall_ == 0 || routeCooldown_ == 0) revert ZeroAddress();
        if (uint256(initialCreatorBps_) + initialBuybackBps_ + initialRewardsBps_ != BPS) revert BadSplit();

        realCreator = realCreator_;
        deployer = msg.sender;
        factory = factory_;
        hook = hook_;
        whype = whype_;
        poolManager = IPoolManager(poolManager_);
        maxSlippageBps = maxSlippageBps_;
        maxRoutePerCall = maxRoutePerCall_;
        routeCooldown = routeCooldown_;

        creatorBps = initialCreatorBps_;
        buybackBps = initialBuybackBps_;
        rewardsBps = initialRewardsBps_;
    }

    /// @notice One-time wiring by the factory (token doesn't exist at construction).
    function initToken(address token_) external {
        if (msg.sender != deployer && msg.sender != realCreator) revert NotAuthorized();
        if (wired) revert AlreadyWired();
        if (token_ == address(0)) revert ZeroAddress();
        if (ITokenV5(token_).creator() != address(this)) revert NotAuthorized();
        token = token_;
        stakingVault = address(new HolderStakingVault(token_, whype, address(this)));
        wired = true;
        emit Wired(token_, stakingVault);
    }

    /// @notice Derive the token's WHYPE pool key once graduation has happened.
    ///         Permissionless (reads only public state).
    function wireBuybackPool() external {
        if (!wired) revert NotWired();
        if (buybackWired) revert AlreadyWired();
        if (!IFactoryV5Graduated(factory).graduated(token)) revert NotGraduated();

        bool tokenIsC0 = token < whype;
        Currency c0 = Currency.wrap(tokenIsC0 ? token : whype);
        Currency c1 = Currency.wrap(tokenIsC0 ? whype : token);
        _buybackPoolKey = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(hook)});
        buybackWired = true;
        emit BuybackWired(Currency.unwrap(c0), Currency.unwrap(c1));
    }

    function scheduleSplit(uint16 creatorBps_, uint16 buybackBps_, uint16 rewardsBps_) external onlyRealCreator {
        if (uint256(creatorBps_) + buybackBps_ + rewardsBps_ != BPS) revert BadSplit();
        bool instant = creatorBps_ <= creatorBps && buybackBps_ >= buybackBps && rewardsBps_ >= rewardsBps;
        if (instant) {
            bool cancelledPending = hasPendingSplit;
            creatorBps = creatorBps_;
            buybackBps = buybackBps_;
            rewardsBps = rewardsBps_;
            hasPendingSplit = false;
            emit SplitAppliedInstant(creatorBps_, buybackBps_, rewardsBps_, cancelledPending);
            return;
        }
        pendingCreatorBps = creatorBps_;
        pendingBuybackBps = buybackBps_;
        pendingRewardsBps = rewardsBps_;
        pendingEffectiveAt = uint64(block.timestamp + SPLIT_DELAY);
        hasPendingSplit = true;
        emit SplitScheduled(creatorBps_, buybackBps_, rewardsBps_, pendingEffectiveAt);
    }

    function applySplit() public {
        if (!hasPendingSplit || block.timestamp < pendingEffectiveAt) return;
        creatorBps = pendingCreatorBps;
        buybackBps = pendingBuybackBps;
        rewardsBps = pendingRewardsBps;
        hasPendingSplit = false;
        emit SplitApplied(creatorBps, buybackBps, rewardsBps);
    }

    /// @notice Permissionless. Claims WHYPE fees from the hook and splits them.
    function route(uint256 wantAmount, uint256 minBuybackOut) external nonReentrant returns (uint256 routedAmount) {
        if (!wired) revert NotWired();
        applySplit();
        uint256 ready = lastRouteAt == 0 ? 0 : lastRouteAt + routeCooldown;
        if (block.timestamp < ready) revert Cooldown(ready);

        IGen5HookClaim(hook).claim(whype);

        uint256 available = IERC20(whype).balanceOf(address(this));
        routedAmount = (wantAmount == 0 || wantAmount > available) ? available : wantAmount;
        if (routedAmount > maxRoutePerCall) routedAmount = maxRoutePerCall;
        if (routedAmount == 0) revert NothingToRoute();

        lastRouteAt = block.timestamp; // CEI

        uint256 toCreator = (routedAmount * creatorBps) / BPS;
        uint256 toBuyback = (routedAmount * buybackBps) / BPS;
        uint256 toRewards = routedAmount - toCreator - toBuyback; // remainder, no dust

        if (toCreator > 0) {
            IERC20(whype).safeTransfer(realCreator, toCreator);
            totalRoutedToCreator += toCreator;
        }
        if (toBuyback > 0) _routeBuyback(toBuyback, minBuybackOut);
        if (toRewards > 0) _routeRewards(toRewards);

        emit Routed(msg.sender, routedAmount, toCreator, toBuyback, toRewards);
    }

    function flushDeferredBuyback(uint256 minOut) external nonReentrant returns (uint256 bought) {
        if (!buybackWired) revert BuybackNotWired();
        uint256 amountIn = pendingBuybackWhype;
        if (amountIn == 0) revert NothingToRoute();
        pendingBuybackWhype = 0;
        bought = _swapExactIn(_buybackPoolKey, whype, amountIn, minOut);
        IERC20(token).safeTransfer(DEAD, bought);
        totalRoutedToBuyback += amountIn;
        totalTokenBurned += bought;
        emit RoutedToBuyback(amountIn, bought);
    }

    function _routeBuyback(uint256 amountIn, uint256 minOut) internal {
        if (!buybackWired) {
            pendingBuybackWhype += amountIn;
            emit BuybackDeferred(amountIn);
            return;
        }
        uint256 bought = _swapExactIn(_buybackPoolKey, whype, amountIn, minOut);
        IERC20(token).safeTransfer(DEAD, bought);
        totalRoutedToBuyback += amountIn;
        totalTokenBurned += bought;
        emit RoutedToBuyback(amountIn, bought);
    }

    function _routeRewards(uint256 amount) internal {
        IERC20(whype).safeTransfer(stakingVault, amount);
        HolderStakingVault(stakingVault).notifyReward(amount);
        totalRoutedToRewards += amount;
        emit RoutedToRewards(amount);
    }

    function _swapExactIn(PoolKey memory key, address tokenIn, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 out)
    {
        out = abi.decode(poolManager.unlock(abi.encode(key, tokenIn, amountIn)), (uint256));
        if (out < minOut) revert MinAmountOutNotMet(out, minOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, address tokenIn, uint256 amountIn) = abi.decode(data, (PoolKey, address, uint256));
        bool zeroForOne = Currency.unwrap(key.currency0) == tokenIn;

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint160 sqrtPriceLimitX96;
        if (zeroForOne) {
            uint256 rawLimit = (uint256(sqrtPriceX96) * (2 * BPS - maxSlippageBps)) / (2 * BPS);
            uint160 minLimit = TickMath.MIN_SQRT_PRICE + 1;
            sqrtPriceLimitX96 = rawLimit <= minLimit ? minLimit : uint160(rawLimit);
        } else {
            uint256 rawLimit = (uint256(sqrtPriceX96) * (2 * BPS + maxSlippageBps)) / (2 * BPS);
            uint160 maxLimit = TickMath.MAX_SQRT_PRICE - 1;
            sqrtPriceLimitX96 = rawLimit >= maxLimit ? maxLimit : uint160(rawLimit);
        }

        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            ""
        );

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        uint256 out;
        if (zeroForOne) {
            if (d0 < 0) key.currency0.settle(poolManager, address(this), uint256(uint128(-d0)), false);
            out = d1 > 0 ? uint256(uint128(d1)) : 0;
            if (out > 0) key.currency1.take(poolManager, address(this), out, false);
        } else {
            if (d1 < 0) key.currency1.settle(poolManager, address(this), uint256(uint128(-d1)), false);
            out = d0 > 0 ? uint256(uint128(d0)) : 0;
            if (out > 0) key.currency0.take(poolManager, address(this), out, false);
        }
        return abi.encode(out);
    }

    function setMetadataURI(string calldata newURI) external onlyRealCreator {
        ITokenV5(token).setMetadataURI(newURI);
    }

    function buybackPoolKey() external view returns (PoolKey memory) {
        return _buybackPoolKey;
    }

    function readyAt() external view returns (uint256) {
        return lastRouteAt == 0 ? 0 : lastRouteAt + routeCooldown;
    }
}
