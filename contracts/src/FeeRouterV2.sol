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
// Reuse the SAME basket types as v1 so runBasket args, mocks and tests are
// interchangeable across both router versions.
import {BasketLeg, IBasketZapLike} from "./FeeRouter.sol";

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
    /// @notice token => id+1 (0 means unknown). The parent-token family check reads
    ///         this to prove a designated parent is genuinely Ballast-launched.
    function launchIdOf(address token) external view returns (uint256);
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

/// @title FeeRouterV2 — v1 FeeRouter + an initial split active from block one, an
///        asymmetric split-change delay, and a 5th "parent burn" bucket (token families)
///
/// @notice Identical to FeeRouter in every other respect (one instance per token,
///         permissionless route()/runBasket, immutable realCreator, no owner/admin/
///         upgrade/pause). THREE differences, all additive:
///         (1) the creator's chosen split is set in the constructor and is ACTIVE
///             from block one — no 7-day wait for the launch split;
///         (2) scheduleSplit() applies INSTANTLY when the creator only moves share
///             AWAY from themselves (creator bps down, every other bucket up-or-
///             equal) — strictly less self-dealing, so safe with no delay — while
///             anything else (raising the creator share, or shifting between the
///             non-creator buckets) keeps the fixed 7-day delay; and
///         (3) a 5th bucket, `parentBurn`, buys an immutable `parent` token through
///             its WETH pool and sends it to the dead address — the same buyback-and-
///             burn mechanic, just pointed at a *different* Ballast-launched token so
///             a family of tokens can route fees into burning their shared parent.
///
/// @dev Deployed brand-new alongside v1; it does NOT touch v1, existing routers,
///      gen-1..4 core, the hook, FeeConfig, AssetRegistry or BasketZap.
///
///      Base behavior (unchanged from v1): one dedicated instance per token (see
///      docs/FEE_ROUTER_DESIGN.md §1.1 — BallastHook.owed is keyed by address only,
///      so a shared router used as `creator` for multiple tokens would commingle
///      their fees). Splits incoming WETH fees across five creator-set buckets:
///      (a) the creator wallet, (b) swapped into the treasury's asset and locked
///      forever, (c) bought back and burned, (d) parent bought and burned,
///      (e) streamed to opt-in stakers.
///
///      No platform key anywhere. The only privileged address is `realCreator` —
///      the human who launched the project — and its only powers are scheduling a
///      split change and the Token/Treasury creator-passthrough calls below (needed
///      because, when this router IS the on-chain `creator` of record, those
///      contracts' `onlyCreator` checks see this router's address — see design doc
///      §2.1/§1.1). route()/routeIn()/flushDeferred*()/wire*()/applySplit() are all
///      permissionless.
contract FeeRouterV2 is IUnlockCallback, ReentrancyGuard {
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
    address public immutable deployer; // FeeRouterFactoryV2, allowed to call launchNew once alongside realCreator
    address public immutable factory;
    address public immutable hook;
    address public immutable weth;
    IPoolManager public immutable poolManager;

    /// @notice The one, fixed BasketZap this router may drive via runBasket. Set at
    ///         construction (by FeeRouterFactoryV2), never a caller-supplied target.
    ///         address(0) permanently disables runBasket for this router.
    address public immutable basketZap;

    /// @notice Asset the treasury bucket swaps into and locks forever. address(0)
    ///         permanently disables that bucket (enforced: treasuryBps must stay 0).
    address public immutable treasuryAsset;

    /// @notice The immutable parent token of this launch's family. address(0) means
    ///         no parent — the parentBurn bucket is then permanently unavailable
    ///         (enforced: parentBurnBps must stay 0). When set, it is validated at
    ///         construction to be a Ballast-launched token (launchIdOf != 0) and, in
    ///         _wire, to never equal this launch's own token (no self-burn family).
    address public immutable parent;

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

    // Parent-burn pool, wired the same permissionless way as the buyback pool.
    bool public parentWired;
    PoolKey internal _parentPoolKey;
    uint256 public pendingParentBurnWeth;

    // --------------------------------------------------------------------- //
    //  Split — active + scheduled (5 buckets)                                //
    // --------------------------------------------------------------------- //

    uint16 public creatorBps = uint16(BPS); // default: 100% to creator
    uint16 public treasuryBps;
    uint16 public buybackBps;
    uint16 public parentBurnBps;
    uint16 public rewardsBps;

    bool public hasPendingSplit;
    uint16 public pendingCreatorBps;
    uint16 public pendingTreasuryBps;
    uint16 public pendingBuybackBps;
    uint16 public pendingParentBurnBps;
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
    uint256 public totalRoutedToParentBurn;
    uint256 public totalParentBurned;
    uint256 public totalRoutedToRewards;

    // --------------------------------------------------------------------- //
    //  Events                                                               //
    // --------------------------------------------------------------------- //

    event Wired(address indexed token, address indexed treasury, address stakingVault);
    event BuybackWired(address currency0, address currency1);
    /// @notice Emitted once in the constructor when a non-zero parent is configured.
    event ParentSet(address indexed parent);
    event ParentWired(address currency0, address currency1);
    event SplitScheduled(
        uint16 creatorBps, uint16 treasuryBps, uint16 buybackBps, uint16 parentBurnBps, uint16 rewardsBps, uint64 effectiveAt
    );
    event SplitApplied(uint16 creatorBps, uint16 treasuryBps, uint16 buybackBps, uint16 parentBurnBps, uint16 rewardsBps);
    // v2: a creator-share-lowering change that took effect immediately (no delay).
    // `cancelledPending` is true if it also wiped out a previously scheduled change.
    event SplitAppliedInstant(
        uint16 creatorBps, uint16 treasuryBps, uint16 buybackBps, uint16 parentBurnBps, uint16 rewardsBps, bool cancelledPending
    );
    event Routed(
        address indexed caller, uint256 total, uint256 toCreator, uint256 toTreasury, uint256 toBuyback, uint256 toParentBurn, uint256 toRewards
    );
    event RoutedToTreasury(uint256 wethIn, uint256 assetOut);
    event RoutedToBuyback(uint256 wethIn, uint256 tokenBought);
    event BuybackDeferred(uint256 wethIn);
    /// @notice The parentBurn bucket bought `parentOut` of `parent` with `wethIn`
    ///         WETH and sent it to the dead address. `parent` is indexed so a parent
    ///         token can enumerate every burn its children performed.
    event ParentBurned(address indexed parent, uint256 wethIn, uint256 parentOut);
    event ParentBurnDeferred(uint256 wethIn);
    event RoutedToRewards(uint256 amount);
    event RoutedInToCreator(address indexed currency, uint256 amount);
    event BasketRun(address indexed caller, uint256 ethIn, uint256[] deposited);

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
    error BasketZapNotSet();
    error BadBasketAsset(address asset);
    error EthRefundFailed();
    // v2 families
    error ParentRequired(); // parentBurnBps > 0 but no parent configured
    error NotBallastParent(); // parent isn't a Ballast-launched token
    error ParentIsSelf(); // parent == this launch's own token
    error ParentNotWired();
    error ParentPoolNotReady(); // parent not graduated, or no live WETH pool

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
        bytes32 disclosureVersion_,
        address basketZap_,
        // v2: optional immutable parent for the parentBurn bucket. address(0) = none.
        address parent_,
        // v2: the creator's chosen split, ACTIVE from block one. Set once here (in
        // the same tx as createAndLaunch) and never via this path again — later
        // changes go through scheduleSplit. For the adopt/createForExisting path,
        // pass the default (10000/0/0/0/0) and no parent.
        uint16 initialCreatorBps_,
        uint16 initialTreasuryBps_,
        uint16 initialBuybackBps_,
        uint16 initialParentBurnBps_,
        uint16 initialRewardsBps_
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

        // Validate the initial split with the SAME rules as scheduleSplit: must sum
        // to BPS, treasury bucket rejected while unsupported (treasuryAsset == 0),
        // and parentBurn bucket rejected while no parent is set. Active immediately —
        // no delay for the launch split.
        if (
            uint256(initialCreatorBps_) + initialTreasuryBps_ + initialBuybackBps_ + initialParentBurnBps_
                + initialRewardsBps_ != BPS
        ) revert BadSplit();
        if (initialTreasuryBps_ > 0 && treasuryAsset_ == address(0)) revert TreasuryBucketDisabled();
        if (initialParentBurnBps_ > 0 && parent_ == address(0)) revert ParentRequired();

        // A configured parent must be a genuinely Ballast-launched token (the
        // "with a WETH pool / can't be self" halves of the family rule are checked
        // later: the pool at wireParentPool() — it may not exist until graduation,
        // exactly like the buyback pool — and self at _wire(), once the token exists).
        if (parent_ != address(0)) {
            if (IBallastFactoryLaunch(factory_).launchIdOf(parent_) == 0) revert NotBallastParent();
        }

        realCreator = realCreator_;
        deployer = msg.sender;
        factory = factory_;
        hook = hook_;
        weth = weth_;
        poolManager = IPoolManager(poolManager_);
        treasuryAsset = treasuryAsset_;
        parent = parent_;
        _treasuryPoolKey = treasuryPoolKey_;
        maxSlippageBps = maxSlippageBps_;
        maxRoutePerCall = maxRoutePerCall_;
        routeCooldown = routeCooldown_;
        disclosureVersion = disclosureVersion_;
        basketZap = basketZap_; // address(0) allowed — runBasket then reverts BasketZapNotSet

        creatorBps = initialCreatorBps_;
        treasuryBps = initialTreasuryBps_;
        buybackBps = initialBuybackBps_;
        parentBurnBps = initialParentBurnBps_;
        rewardsBps = initialRewardsBps_;

        if (parent_ != address(0)) emit ParentSet(parent_);
    }

    /// @notice Accept native ETH — only ever the leftover BasketZap refunds during
    ///         runBasket (forwarded straight to realCreator there). The router keeps
    ///         no native-ETH accounting; all fee buckets are WETH (ERC-20).
    receive() external payable {}

    // --------------------------------------------------------------------- //
    //  Wiring — token doesn't exist until one of these runs, exactly once   //
    // --------------------------------------------------------------------- //

    /// @notice Router-as-creator path: THIS contract calls launch(), becoming the
    ///         on-chain creator of both the token and its treasury. Callable by
    ///         realCreator directly, or by `deployer` (FeeRouterFactoryV2) so the
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
        // A token can never be in its own family (would let the parentBurn bucket
        // burn the launch token itself through a mislabelled pool). parent is
        // immutable and this is the first moment `token` is known.
        if (parent != address(0) && token_ == parent) revert ParentIsSelf();
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

    /// @notice Derives the PARENT token's WETH pool key the same way wireBuybackPool
    ///         does for the launch token, once the parent has graduated AND has a
    ///         live WETH pool. Permissionless (reads only public state). Until this
    ///         succeeds, the parentBurn share is deferred by route() and swept later
    ///         by flushDeferredParentBurn — exactly the buyback bucket's behavior.
    function wireParentPool() external {
        if (parent == address(0)) revert ParentRequired();
        if (parentWired) revert AlreadyWired();
        if (!IBallastFactoryLaunch(factory).graduated(parent)) revert ParentPoolNotReady();

        bool parentIsC0 = parent < weth;
        Currency c0 = Currency.wrap(parentIsC0 ? parent : weth);
        Currency c1 = Currency.wrap(parentIsC0 ? weth : parent);
        PoolKey memory key = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(hook)});
        // "with a WETH pool": a graduated parent might have opened only non-WETH
        // (GREEN) pools, in which case this pool was never initialized. Reject so a
        // parentBurn share can never be swapped into a non-existent pool.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        if (sqrtPriceX96 == 0) revert ParentPoolNotReady();

        _parentPoolKey = key;
        parentWired = true;
        emit ParentWired(Currency.unwrap(c0), Currency.unwrap(c1));
    }

    // --------------------------------------------------------------------- //
    //  Split — v2 asymmetric delay                                          //
    //                                                                       //
    //  INSTANT iff the creator only moves share AWAY from themselves:       //
    //    new creator <= current creator AND every other bucket >= current.  //
    //  That is strictly less self-dealing (never routes MORE to the human), //
    //  so there's no reason to make holders wait. Anything else — raising   //
    //  the creator share, or shifting value between the non-creator buckets //
    //  (e.g. buyback -> staking) — keeps the fixed 7-day delay. An instant  //
    //  change also cancels any pending scheduled change.                    //
    // --------------------------------------------------------------------- //

    function scheduleSplit(
        uint16 creatorBps_,
        uint16 treasuryBps_,
        uint16 buybackBps_,
        uint16 parentBurnBps_,
        uint16 rewardsBps_
    ) external onlyRealCreator {
        if (uint256(creatorBps_) + treasuryBps_ + buybackBps_ + parentBurnBps_ + rewardsBps_ != BPS) revert BadSplit();
        if (treasuryBps_ > 0 && treasuryAsset == address(0)) revert TreasuryBucketDisabled();
        if (parentBurnBps_ > 0 && parent == address(0)) revert ParentRequired();

        bool instant = creatorBps_ <= creatorBps && treasuryBps_ >= treasuryBps && buybackBps_ >= buybackBps
            && parentBurnBps_ >= parentBurnBps && rewardsBps_ >= rewardsBps;

        if (instant) {
            bool cancelledPending = hasPendingSplit;
            creatorBps = creatorBps_;
            treasuryBps = treasuryBps_;
            buybackBps = buybackBps_;
            parentBurnBps = parentBurnBps_;
            rewardsBps = rewardsBps_;
            hasPendingSplit = false; // an instant change supersedes any pending one
            emit SplitAppliedInstant(creatorBps_, treasuryBps_, buybackBps_, parentBurnBps_, rewardsBps_, cancelledPending);
            return;
        }

        pendingCreatorBps = creatorBps_;
        pendingTreasuryBps = treasuryBps_;
        pendingBuybackBps = buybackBps_;
        pendingParentBurnBps = parentBurnBps_;
        pendingRewardsBps = rewardsBps_;
        pendingEffectiveAt = uint64(block.timestamp + SPLIT_DELAY);
        hasPendingSplit = true;
        emit SplitScheduled(creatorBps_, treasuryBps_, buybackBps_, parentBurnBps_, rewardsBps_, pendingEffectiveAt);
    }

    function applySplit() public {
        if (!hasPendingSplit || block.timestamp < pendingEffectiveAt) return;
        creatorBps = pendingCreatorBps;
        treasuryBps = pendingTreasuryBps;
        buybackBps = pendingBuybackBps;
        parentBurnBps = pendingParentBurnBps;
        rewardsBps = pendingRewardsBps;
        hasPendingSplit = false;
        emit SplitApplied(creatorBps, treasuryBps, buybackBps, parentBurnBps, rewardsBps);
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
    /// @param minParentOut Slippage floor for the parentBurn swap (ignored if that
    ///        bucket routes 0, or the parent pool isn't wired yet).
    function route(uint256 wantAmount, uint256 minTreasuryOut, uint256 minBuybackOut, uint256 minParentOut)
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
        uint256 toParentBurn = (routedAmount * parentBurnBps) / BPS;
        uint256 toRewards = routedAmount - toCreator - toTreasury - toBuyback - toParentBurn; // remainder, no dust lost

        if (toCreator > 0) {
            IERC20(weth).safeTransfer(realCreator, toCreator);
            totalRoutedToCreator += toCreator;
        }
        if (toTreasury > 0) _routeTreasury(toTreasury, minTreasuryOut);
        if (toBuyback > 0) _routeBuyback(toBuyback, minBuybackOut);
        if (toParentBurn > 0) _routeParentBurn(toParentBurn, minParentOut);
        if (toRewards > 0) _routeRewards(toRewards);

        emit Routed(msg.sender, routedAmount, toCreator, toTreasury, toBuyback, toParentBurn, toRewards);
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

    /// @notice One-tx stock basket for a router-launched token: swap ETH across up
    ///         to 6 listed stock tokens through the fixed BasketZap and deposit what
    ///         the swap produced into THIS token's treasury, all in one call.
    ///
    /// @dev Only usable when this router IS the token's on-chain creator (the
    ///      launchNew path) — BasketZap's own `msg.sender == creator` check enforces
    ///      that, and it sends every output + any ETH refund back here. Safety: a leg
    ///      asset may never be WETH or the launch token (bucket/burn funds), and only
    ///      the DELTA each leg's balance gained from this swap is deposited — a
    ///      pre-existing balance (e.g. pendingBuybackWeth, or any WETH route() still
    ///      owes a bucket) can never be swept in. The deposit is a plain
    ///      treasury.deposit (creator-withdrawable), same semantics as creatorDeposit.
    function runBasket(BasketLeg[] calldata legs, uint256 swapDeadline)
        external
        payable
        onlyRealCreator
        nonReentrant
        returns (uint256[] memory deposited)
    {
        if (!wired) revert NotWired();
        if (basketZap == address(0)) revert BasketZapNotSet();
        uint256 n = legs.length;
        deposited = new uint256[](n);

        uint256[] memory beforeBal = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = legs[i].asset;
            if (a == weth || a == token) revert BadBasketAsset(a);
            beforeBal[i] = IERC20(a).balanceOf(address(this));
        }

        // Router is the on-chain creator, so outputs + ETH refund come back here.
        IBasketZapLike(basketZap).swapBasket{value: msg.value}(token, legs, swapDeadline);

        for (uint256 i = 0; i < n; i++) {
            address a = legs[i].asset;
            uint256 delta = IERC20(a).balanceOf(address(this)) - beforeBal[i];
            if (delta > 0) {
                IERC20(a).forceApprove(treasury, delta);
                IProjectTreasuryLike(treasury).deposit(a, delta);
                deposited[i] = delta;
            }
        }

        // Leftover ETH BasketZap refunded to this router → realCreator (the router
        // never holds native ETH of its own; every bucket is WETH).
        uint256 leftover = address(this).balance;
        if (leftover > 0) {
            (bool sent,) = realCreator.call{value: leftover}("");
            if (!sent) revert EthRefundFailed();
        }

        emit BasketRun(msg.sender, msg.value, deposited);
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

    /// @notice Sweep WETH deferred while the PARENT pool wasn't wired yet. Buys the
    ///         parent and sends it to the dead address. Permissionless, mirrors
    ///         flushDeferredBuyback exactly.
    function flushDeferredParentBurn(uint256 minOut) external nonReentrant returns (uint256 bought) {
        if (!parentWired) revert ParentNotWired();
        uint256 amountIn = pendingParentBurnWeth;
        if (amountIn == 0) revert NothingToRoute();
        pendingParentBurnWeth = 0;
        bought = _swapExactIn(_parentPoolKey, weth, amountIn, minOut);
        IERC20(parent).safeTransfer(DEAD, bought);
        totalRoutedToParentBurn += amountIn;
        totalParentBurned += bought;
        emit ParentBurned(parent, amountIn, bought);
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

    function _routeParentBurn(uint256 amountIn, uint256 minOut) internal {
        if (!parentWired) {
            pendingParentBurnWeth += amountIn;
            emit ParentBurnDeferred(amountIn);
            return;
        }
        uint256 bought = _swapExactIn(_parentPoolKey, weth, amountIn, minOut);
        IERC20(parent).safeTransfer(DEAD, bought);
        totalRoutedToParentBurn += amountIn;
        totalParentBurned += bought;
        emit ParentBurned(parent, amountIn, bought);
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

    function parentPoolKey() external view returns (PoolKey memory) {
        return _parentPoolKey;
    }

    function readyAt() external view returns (uint256) {
        return lastRouteAt == 0 ? 0 : lastRouteAt + routeCooldown;
    }
}
