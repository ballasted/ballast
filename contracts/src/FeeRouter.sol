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
import {HolderStakingVault} from "./HolderStakingVault.sol";

interface IBallastHookClaim {
    function claim() external returns (uint256);
    function owed(address) external view returns (uint256);
    function claimIn(address currency) external returns (uint256);
    function owedIn(address, address) external view returns (uint256);
}

interface IBallastFactoryLaunch {
    function launch(
        string calldata name_,
        string calldata symbol_,
        uint256 noticePeriod,
        string calldata metadataURI,
        address[] calldata quoteAssets_
    ) external returns (uint256 id, address token, address treasury);
    function graduated(address token) external view returns (bool);
}

interface IBallastTokenLike {
    function creator() external view returns (address);
    function treasury() external view returns (address);
    function setMetadataURI(string calldata newURI) external;
}

interface IProjectTreasuryLike {
    function deposit(address asset, uint256 amount) external;
    function proposeDeposit(address asset, uint256 amount, bytes32 disclosureVersion) external returns (uint256 id);
    function acceptDeposit(uint256 id) external;
    function declineDeposit(uint256 id) external;
    function announceWithdrawal(address asset, uint256 amount) external returns (uint256 id);
    function executeWithdrawal(uint256 id) external;
    function cancelWithdrawal(uint256 id) external;
    function withdrawals(uint256 id) external view returns (address asset, uint256 amount, uint64 unlockAt, uint8 status);
    function registry() external view returns (address);
}

interface IAssetRegistryAllowed {
    function isAllowed(address asset) external view returns (bool);
}

/// @title FeeRouter — lets a token's creator decide where their gen-4 trading fees go
///
/// @notice One dedicated instance per token (see docs/FEE_ROUTER_DESIGN.md §1.1 for
///         why: BallastHook.owed is keyed by address only, so a shared router used
///         as `creator` for multiple tokens would commingle their fees). Splits
///         incoming WETH fees across four buckets in creator-set, time-delayed bps:
///         (a) the creator wallet, (b) swapped into the treasury's asset and locked
///         forever, (c) bought back and burned, (d) streamed to opt-in stakers.
///
/// @dev No platform key anywhere. The only privileged address is `realCreator` —
///      the human who launched the project — and its only powers are scheduling a
///      split change (7-day delay, never skippable) and the Token/Treasury
///      creator-passthrough calls below (needed because, when this router IS the
///      on-chain `creator` of record, those contracts' `onlyCreator` checks see
///      this router's address, not the human's — see design doc §2.1/§1.1). Those
///      passthroughs grant no privilege beyond what `realCreator` already had before
///      opting into a router; they exist only so opting in doesn't strand them.
///
///      `route()` is permissionless and pulls whatever this router is owed as the
///      recorded creator (harmless no-op if it isn't — see IBallastHookClaim.claim).
///      For tokens adopted after the fact (existing EOA creator, §1.4 of the design
///      doc), the creator must claim() and send WETH here themselves; route() then
///      splits whatever balance it holds, same permissionless logic either way.
contract FeeRouter is IUnlockCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant SPLIT_DELAY = 7 days;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000; // 20% hard ceiling, same as BuybackBurnerV2
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    int24 internal constant TICK_SPACING = 60;

    // --------------------------------------------------------------------- //
    //  Immutable identity + config                                          //
    // --------------------------------------------------------------------- //

    address public immutable realCreator;
    address public immutable deployer; // FeeRouterFactory, allowed to call launchNew once alongside realCreator
    address public immutable factory;
    address public immutable hook;
    address public immutable weth;
    IPoolManager public immutable poolManager;

    /// @notice Asset the treasury bucket swaps into and locks forever. address(0)
    ///         permanently disables that bucket (enforced: treasuryBps must stay 0).
    address public immutable treasuryAsset;
    uint16 public immutable maxSlippageBps;
    uint256 public immutable maxRoutePerCall;
    uint256 public immutable routeCooldown;
    /// @notice Disclosure hash attached to every treasury-bucket proposeDeposit.
    bytes32 public immutable disclosureVersion;

    // Set once in the constructor; not `immutable` because it is a struct
    // containing Currency values, which Solidity does not allow as immutable.
    PoolKey internal _treasuryPoolKey;

    // --------------------------------------------------------------------- //
    //  Wired at launch/adopt time (token doesn't exist at construction)     //
    // --------------------------------------------------------------------- //

    bool public wired;
    address public token;
    address public treasury;
    address public stakingVault;

    bool public buybackWired;
    PoolKey internal _buybackPoolKey;
    uint256 public pendingBuybackWeth;

    // --------------------------------------------------------------------- //
    //  Split — active + scheduled                                          //
    // --------------------------------------------------------------------- //

    uint16 public creatorBps = uint16(BPS); // default: 100% to creator
    uint16 public treasuryBps;
    uint16 public buybackBps;
    uint16 public rewardsBps;

    bool public hasPendingSplit;
    uint16 public pendingCreatorBps;
    uint16 public pendingTreasuryBps;
    uint16 public pendingBuybackBps;
    uint16 public pendingRewardsBps;
    uint64 public pendingEffectiveAt;

    uint256 public lastRouteAt;

    // --------------------------------------------------------------------- //
    //  Totals (informational)                                              //
    // --------------------------------------------------------------------- //

    uint256 public totalRoutedToCreator;
    uint256 public totalRoutedToTreasury;
    uint256 public totalTreasuryAssetDeposited;
    uint256 public totalRoutedToBuyback;
    uint256 public totalTokenBurned;
    uint256 public totalRoutedToRewards;

    // --------------------------------------------------------------------- //
    //  Events                                                               //
    // --------------------------------------------------------------------- //

    event Wired(address indexed token, address indexed treasury, address stakingVault);
    event BuybackWired(address currency0, address currency1);
    event SplitScheduled(uint16 creatorBps, uint16 treasuryBps, uint16 buybackBps, uint16 rewardsBps, uint64 effectiveAt);
    event SplitApplied(uint16 creatorBps, uint16 treasuryBps, uint16 buybackBps, uint16 rewardsBps);
    event Routed(address indexed caller, uint256 total, uint256 toCreator, uint256 toTreasury, uint256 toBuyback, uint256 toRewards);
    event RoutedToTreasury(uint256 wethIn, uint256 assetOut);
    event RoutedToBuyback(uint256 wethIn, uint256 tokenBought);
    event BuybackDeferred(uint256 wethIn);
    event RoutedToRewards(uint256 amount);
    event RoutedInToCreator(address indexed currency, uint256 amount);

    // --------------------------------------------------------------------- //
    //  Errors                                                               //
    // --------------------------------------------------------------------- //

    error ZeroAddress();
    error NotRealCreator();
    error NotAuthorized();
    error AlreadyWired();
    error NotWired();
    error NotGraduated();
    error BuybackNotWired();
    error BadSplit();
    error TreasuryBucketDisabled();
    error NotTokenCreator();
    error TreasuryMismatch();
    error Cooldown(uint256 readyAt);
    error NothingToRoute();
    error NotPoolManager();
    error MinAmountOutNotMet(uint256 got, uint256 wanted);
    error UseRouteForWeth();

    modifier onlyRealCreator() {
        if (msg.sender != realCreator) revert NotRealCreator();
        _;
    }

    constructor(
        address realCreator_,
        address factory_,
        address hook_,
        address weth_,
        address poolManager_,
        address treasuryAsset_,
        PoolKey memory treasuryPoolKey_,
        address registry_,
        uint16 maxSlippageBps_,
        uint256 maxRoutePerCall_,
        uint256 routeCooldown_,
        bytes32 disclosureVersion_
    ) {
        if (
            realCreator_ == address(0) || factory_ == address(0) || hook_ == address(0) || weth_ == address(0)
                || poolManager_ == address(0) || registry_ == address(0)
        ) revert ZeroAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS) revert BadSplit();
        if (maxRoutePerCall_ == 0 || routeCooldown_ == 0) revert ZeroAddress();
        if (treasuryAsset_ != address(0) && !IAssetRegistryAllowed(registry_).isAllowed(treasuryAsset_)) {
            revert TreasuryBucketDisabled();
        }
        if (disclosureVersion_ == bytes32(0)) revert ZeroAddress();

        realCreator = realCreator_;
        deployer = msg.sender;
        factory = factory_;
        hook = hook_;
        weth = weth_;
        poolManager = IPoolManager(poolManager_);
        treasuryAsset = treasuryAsset_;
        _treasuryPoolKey = treasuryPoolKey_;
        maxSlippageBps = maxSlippageBps_;
        maxRoutePerCall = maxRoutePerCall_;
        routeCooldown = routeCooldown_;
        disclosureVersion = disclosureVersion_;
    }

    // --------------------------------------------------------------------- //
    //  Wiring — token doesn't exist until one of these runs, exactly once   //
    // --------------------------------------------------------------------- //

    /// @notice Router-as-creator path: THIS contract calls launch(), becoming the
    ///         on-chain creator of both the token and its treasury. Callable by
    ///         realCreator directly, or by `deployer` (FeeRouterFactory) so the
    ///         whole flow can be one atomic transaction from the creator's wallet.
    function launchNew(
        string calldata name_,
        string calldata symbol_,
        uint256 noticePeriod,
        string calldata metadataURI,
        address[] calldata quoteAssets_
    ) external returns (address token_, address treasury_) {
        if (msg.sender != realCreator && msg.sender != deployer) revert NotAuthorized();
        if (wired) revert AlreadyWired();
        (, token_, treasury_) = IBallastFactoryLaunch(factory).launch(name_, symbol_, noticePeriod, metadataURI, quoteAssets_);
        _wire(token_, treasury_);
    }

    /// @notice Bucket-splitter-only path for a token that already exists with an
    ///         EOA creator (§1.4 of the design doc). This router never becomes the
    ///         on-chain creator here — the treasury bucket stays unavailable
    ///         (treasuryBps must be 0), and the human must claim() + send WETH here
    ///         themselves before calling route().
    function adopt(address token_, address treasury_) external onlyRealCreator {
        if (wired) revert AlreadyWired();
        // The treasury bucket needs this router to BE treasury.creator (§2.1) —
        // never true on the adopt path (the EOA stays creator of record), so a
        // treasuryAsset configured here would make route() revert forever the
        // moment treasuryBps > 0. Block it at wiring time, not at first route().
        if (treasuryAsset != address(0)) revert TreasuryBucketDisabled();
        if (IBallastTokenLike(token_).creator() != realCreator) revert NotTokenCreator();
        if (IBallastTokenLike(token_).treasury() != treasury_) revert TreasuryMismatch();
        _wire(token_, treasury_);
    }

    function _wire(address token_, address treasury_) internal {
        token = token_;
        treasury = treasury_;
        stakingVault = address(new HolderStakingVault(token_, weth, address(this)));
        wired = true;
        emit Wired(token_, treasury_, stakingVault);
    }

    /// @notice Derives the token's own WETH pool key from public, already-fixed
    ///         values (tick spacing, fee, hook are constants on every Ballast pool —
    ///         see design doc §2.5) once graduation has happened. Permissionless:
    ///         nothing here trusts the caller, it only reads public state.
    function wireBuybackPool() external {
        if (!wired) revert NotWired();
        if (buybackWired) revert AlreadyWired();
        if (!IBallastFactoryLaunch(factory).graduated(token)) revert NotGraduated();

        bool tokenIsC0 = token < weth;
        Currency c0 = Currency.wrap(tokenIsC0 ? token : weth);
        Currency c1 = Currency.wrap(tokenIsC0 ? weth : token);
        _buybackPoolKey = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(hook)});
        buybackWired = true;
        emit BuybackWired(Currency.unwrap(c0), Currency.unwrap(c1));
    }

    // --------------------------------------------------------------------- //
    //  Split — creator-scheduled, 7-day delay, never skippable              //
    // --------------------------------------------------------------------- //

    function scheduleSplit(uint16 creatorBps_, uint16 treasuryBps_, uint16 buybackBps_, uint16 rewardsBps_)
        external
        onlyRealCreator
    {
        if (uint256(creatorBps_) + treasuryBps_ + buybackBps_ + rewardsBps_ != BPS) revert BadSplit();
        if (treasuryBps_ > 0 && treasuryAsset == address(0)) revert TreasuryBucketDisabled();

        pendingCreatorBps = creatorBps_;
        pendingTreasuryBps = treasuryBps_;
        pendingBuybackBps = buybackBps_;
        pendingRewardsBps = rewardsBps_;
        pendingEffectiveAt = uint64(block.timestamp + SPLIT_DELAY);
        hasPendingSplit = true;
        emit SplitScheduled(creatorBps_, treasuryBps_, buybackBps_, rewardsBps_, pendingEffectiveAt);
    }

    function applySplit() public {
        if (!hasPendingSplit || block.timestamp < pendingEffectiveAt) return;
        creatorBps = pendingCreatorBps;
        treasuryBps = pendingTreasuryBps;
        buybackBps = pendingBuybackBps;
        rewardsBps = pendingRewardsBps;
        hasPendingSplit = false;
        emit SplitApplied(creatorBps, treasuryBps, buybackBps, rewardsBps);
    }

    // --------------------------------------------------------------------- //
    //  route() — permissionless                                             //
    // --------------------------------------------------------------------- //

    /// @param wantAmount 0 routes the router's full WETH balance (after claiming);
    ///        otherwise caps routing to this amount. Always further capped by
    ///        maxRoutePerCall.
    /// @param minTreasuryOut Slippage floor for the treasury-bucket swap (ignored if
    ///        that bucket routes 0 this call).
    /// @param minBuybackOut Slippage floor for the buyback swap (ignored if that
    ///        bucket routes 0, or the buyback pool isn't wired yet).
    function route(uint256 wantAmount, uint256 minTreasuryOut, uint256 minBuybackOut)
        external
        nonReentrant
        returns (uint256 routedAmount)
    {
        if (!wired) revert NotWired();
        applySplit();
        uint256 ready = lastRouteAt == 0 ? 0 : lastRouteAt + routeCooldown;
        if (block.timestamp < ready) revert Cooldown(ready);

        IBallastHookClaim(hook).claim(); // no-op if this router isn't the recorded creator

        uint256 available = IERC20(weth).balanceOf(address(this));
        routedAmount = (wantAmount == 0 || wantAmount > available) ? available : wantAmount;
        if (routedAmount > maxRoutePerCall) routedAmount = maxRoutePerCall;
        if (routedAmount == 0) revert NothingToRoute();

        lastRouteAt = block.timestamp; // CEI: cooldown starts regardless of swap outcome below

        uint256 toCreator = (routedAmount * creatorBps) / BPS;
        uint256 toTreasury = (routedAmount * treasuryBps) / BPS;
        uint256 toBuyback = (routedAmount * buybackBps) / BPS;
        uint256 toRewards = routedAmount - toCreator - toTreasury - toBuyback; // remainder, no dust lost

        if (toCreator > 0) {
            IERC20(weth).safeTransfer(realCreator, toCreator);
            totalRoutedToCreator += toCreator;
        }
        if (toTreasury > 0) _routeTreasury(toTreasury, minTreasuryOut);
        if (toBuyback > 0) _routeBuyback(toBuyback, minBuybackOut);
        if (toRewards > 0) _routeRewards(toRewards);

        emit Routed(msg.sender, routedAmount, toCreator, toTreasury, toBuyback, toRewards);
    }

    /// @notice Non-WETH quote-asset fees (inert until a non-WETH pool exists — see
    ///         design doc §2.7). No bucket split yet: paid entirely to realCreator
    ///         so nothing is ever stranded once one does exist.
    function routeIn(address currency) external nonReentrant returns (uint256 amount) {
        if (currency == weth) revert UseRouteForWeth();
        IBallastHookClaim(hook).claimIn(currency);
        amount = IERC20(currency).balanceOf(address(this));
        if (amount == 0) revert NothingToRoute();
        IERC20(currency).safeTransfer(realCreator, amount);
        emit RoutedInToCreator(currency, amount);
    }

    /// @notice Sweep WETH that was deferred while the buyback pool wasn't wired yet
    ///         (pre-graduation). Permissionless, same as route() itself.
    function flushDeferredBuyback(uint256 minOut) external nonReentrant returns (uint256 bought) {
        if (!buybackWired) revert BuybackNotWired();
        uint256 amountIn = pendingBuybackWeth;
        if (amountIn == 0) revert NothingToRoute();
        pendingBuybackWeth = 0;
        bought = _swapExactIn(_buybackPoolKey, weth, amountIn, minOut);
        IERC20(token).safeTransfer(DEAD, bought);
        totalRoutedToBuyback += amountIn;
        totalTokenBurned += bought;
        emit RoutedToBuyback(amountIn, bought);
    }

    function _routeTreasury(uint256 amountIn, uint256 minOut) internal {
        uint256 out = _swapExactIn(_treasuryPoolKey, weth, amountIn, minOut);
        IERC20(treasuryAsset).forceApprove(treasury, out);
        uint256 id = IProjectTreasuryLike(treasury).proposeDeposit(treasuryAsset, out, disclosureVersion);
        IProjectTreasuryLike(treasury).acceptDeposit(id);
        totalRoutedToTreasury += amountIn;
        totalTreasuryAssetDeposited += out;
        emit RoutedToTreasury(amountIn, out);
    }

    function _routeBuyback(uint256 amountIn, uint256 minOut) internal {
        if (!buybackWired) {
            pendingBuybackWeth += amountIn;
            emit BuybackDeferred(amountIn);
            return;
        }
        uint256 bought = _swapExactIn(_buybackPoolKey, weth, amountIn, minOut);
        IERC20(token).safeTransfer(DEAD, bought);
        totalRoutedToBuyback += amountIn;
        totalTokenBurned += bought;
        emit RoutedToBuyback(amountIn, bought);
    }

    function _routeRewards(uint256 amount) internal {
        IERC20(weth).safeTransfer(stakingVault, amount);
        HolderStakingVault(stakingVault).notifyReward(amount);
        totalRoutedToRewards += amount;
        emit RoutedToRewards(amount);
    }

    // --------------------------------------------------------------------- //
    //  Direct-PoolManager swap — see design doc §2.4 for why not UniversalRouter //
    // --------------------------------------------------------------------- //

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
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: sqrtPriceLimitX96}),
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

    // --------------------------------------------------------------------- //
    //  Creator/Treasury passthroughs — see contract-level note              //
    // --------------------------------------------------------------------- //

    function creatorDeposit(address asset, uint256 amount) external onlyRealCreator {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(asset).forceApprove(treasury, amount);
        IProjectTreasuryLike(treasury).deposit(asset, amount);
    }

    function acceptDeposit(uint256 id) external onlyRealCreator {
        IProjectTreasuryLike(treasury).acceptDeposit(id);
    }

    function declineDeposit(uint256 id) external onlyRealCreator {
        IProjectTreasuryLike(treasury).declineDeposit(id);
    }

    function announceWithdrawal(address asset, uint256 amount) external onlyRealCreator returns (uint256 id) {
        return IProjectTreasuryLike(treasury).announceWithdrawal(asset, amount);
    }

    /// @notice ProjectTreasury pays out to `creator` (this router) — sweep it
    ///         straight to realCreator so opting into a router never stalls a
    ///         withdrawal the creator was already entitled to.
    function executeWithdrawal(uint256 id) external onlyRealCreator {
        (address asset, uint256 amount,,) = IProjectTreasuryLike(treasury).withdrawals(id);
        IProjectTreasuryLike(treasury).executeWithdrawal(id);
        IERC20(asset).safeTransfer(realCreator, amount);
    }

    function cancelWithdrawal(uint256 id) external onlyRealCreator {
        IProjectTreasuryLike(treasury).cancelWithdrawal(id);
    }

    function setMetadataURI(string calldata newURI) external onlyRealCreator {
        IBallastTokenLike(token).setMetadataURI(newURI);
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                 //
    // --------------------------------------------------------------------- //

    function treasuryPoolKey() external view returns (PoolKey memory) {
        return _treasuryPoolKey;
    }

    function buybackPoolKey() external view returns (PoolKey memory) {
        return _buybackPoolKey;
    }

    function readyAt() external view returns (uint256) {
        return lastRouteAt == 0 ? 0 : lastRouteAt + routeCooldown;
    }
}
