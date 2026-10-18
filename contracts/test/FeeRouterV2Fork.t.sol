// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";
import {BallastHook, BALLAST_HOOK_FLAGS} from "../src/BallastHook.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {FeeRouterV2} from "../src/FeeRouterV2.sol";
import {BasketLeg} from "../src/FeeRouter.sol";
import {FeeRouterFactoryV2} from "../src/FeeRouterFactoryV2.sol";
import {HolderStakingVault} from "../src/HolderStakingVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockBasketZap} from "./mocks/MockBasketZap.sol";

interface IWETH9c {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev Same fresh-but-real-PoolManager pattern as BallastGraduateFork.t.sol: a
///      real BallastFactory/Hook/Seeder deployed fresh on a Robinhood Chain mainnet
///      fork against the REAL, live PoolManager singleton - not the already-live
///      production factory (that one's config is fixed and not ours to add test
///      launches through). The treasury-bucket pool is a plain vanilla v4 pool this
///      file initializes and seeds itself, so the swap it exercises is fully
///      self-derived rather than guessing a real external pool's fee tier/liquidity
///      (see docs/FEE_ROUTER_DESIGN.md §2.4 - that's exactly the kind of unverified
///      address this file avoids hardcoding).
///
///      SKIPS unless RH_RPC_URL_PAID is set.
contract FeeRouterV2ForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 constant DISCLOSURE = keccak256("fee-router v1: auto-routed trading fee, permanently locked, no claim");

    AssetRegistry registry;
    FeeConfig cfg;
    BallastHook hook;
    BallastSeeder seeder;
    BallastFactory factory;
    FeeRouterFactoryV2 routerFactory;
    PoolModifyLiquidityTest lp;
    PoolSwapTest swap;
    MockERC20 treasuryAsset;
    MockERC20 basketAsset2;
    MockBasketZap mockZap;
    PoolKey treasuryKey;

    address platform = makeAddr("platform");
    address realCreator = makeAddr("realCreator");
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        registry = new AssetRegistry(address(this));
        cfg = new FeeConfig(address(this), platform);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), BALLAST_HOOK_FLAGS, type(BallastHook).creationCode, abi.encode(MANAGER, cfg, WETH));
        hook = new BallastHook{salt: salt}(MANAGER, cfg, WETH);
        require(address(hook) == hookAddr, "hook addr mismatch");
        seeder = new BallastSeeder(MANAGER, address(hook));
        hook.setSeeder(address(seeder));

        factory = new BallastFactory(
            address(registry), WETH, seeder, address(_ethFeed()), 24 hours, new address[](0)
        );
        // Mock BasketZap (mints each leg asset to the router - the real swap routing
        // is proven in BasketZapFork.t.sol; here we exercise runBasket's own
        // delta-deposit + bucket-safety against the real treasury/pools).
        mockZap = new MockBasketZap(100e18);
        routerFactory = new FeeRouterFactoryV2(address(mockZap));

        lp = new PoolModifyLiquidityTest(MANAGER);
        swap = new PoolSwapTest(MANAGER);

        vm.deal(address(this), 2000 ether);
        IWETH9c(WETH).deposit{value: 1000 ether}();
        IERC20(WETH).approve(address(lp), type(uint256).max);
        IERC20(WETH).approve(address(swap), type(uint256).max);

        // A self-created, self-seeded WETH/treasuryAsset pool for the treasury
        // bucket's swap - no guessing a real external pool's address/fee tier.
        treasuryAsset = new MockERC20("Mock SGOV", "SGOV", 18);
        registry.setAsset(address(treasuryAsset), address(0xFEED), 1 days, 1); // tiny min: test swaps are small
        treasuryAsset.mint(address(this), 1_000_000e18);
        treasuryAsset.approve(address(lp), type(uint256).max);
        treasuryAsset.approve(address(swap), type(uint256).max);

        // A second registry-listed asset so the basket test uses 2 legs.
        basketAsset2 = new MockERC20("Mock SPY", "SPY", 18);
        registry.setAsset(address(basketAsset2), address(0xFEED), 1 days, 1);

        bool wethIsC0 = WETH < address(treasuryAsset);
        treasuryKey = PoolKey({
            currency0: Currency.wrap(wethIsC0 ? WETH : address(treasuryAsset)),
            currency1: Currency.wrap(wethIsC0 ? address(treasuryAsset) : WETH),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        MANAGER.initialize(treasuryKey, uint160(79228162514264337593543950336)); // 1:1
        lp.modifyLiquidity(
            treasuryKey,
            IPoolManager.ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e20, salt: 0}),
            ""
        );
    }

    function _ethFeed() internal returns (address) {
        // Inline mock so this file doesn't need MockAggregator's constructor
        // signature imported just for a constant $3000 price.
        return address(new FixedFeed(3000e8, block.timestamp));
    }

    function _forceNextLaunchCurrency0() internal {
        uint64 nonce = uint64(vm.getNonce(address(factory)));
        while (vm.computeCreateAddress(address(factory), nonce) >= WETH) {
            nonce++;
        }
        vm.setNonce(address(factory), nonce);
    }

    function _launchViaRouter(uint16 maxSlippageBps)
        internal
        returns (FeeRouterV2 router, address token, address treasury)
    {
        _forceNextLaunchCurrency0();
        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        vm.prank(realCreator);
        (router, token, treasury) = routerFactory.createAndLaunch(
            address(hook),
            WETH,
            address(MANAGER),
            address(treasuryAsset),
            treasuryKey,
            address(registry),
            maxSlippageBps,
            100 ether,
            1 hours,
            DISCLOSURE,
            address(factory),
            "Test",
            "TST",
            30 days,
            "ipfs://test",
            quoteAssets,
            address(0), // no family parent
            10000, // initial split: 100% creator (ported tests then scheduleSplit)
            0,
            0,
            0,
            0
        );
    }

    /// @dev Spends WETH for token. `_forceNextLaunchCurrency0` guarantees
    ///      token == currency0 / WETH == currency1 for every launch in this file,
    ///      so buying is always zeroForOne=false (matches the verified working
    ///      example in BallastGraduateFork.t.sol).
    function _buyTokenWithWeth(PoolKey memory key, uint256 wethIn) internal {
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -int256(wethIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // --------------------------------------------------------------------- //
    //  Full happy path: all four buckets, one real gen-4 pool                //
    // --------------------------------------------------------------------- //

    function test_fork_allFourBuckets_endToEnd() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (FeeRouterV2 router, address token, address treasury) = _launchViaRouter(1000);
        assertEq(MockRouterCheck(token).creator(), address(router), "router must be on-chain creator");

        factory.graduate(token);
        PoolKey memory tokenKey =
            PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});

        // Equal split across all four buckets.
        vm.prank(realCreator);
        router.scheduleSplit(2500, 2500, 2500, 0, 2500);
        vm.warp(block.timestamp + 7 days);
        router.wireBuybackPool();

        // A staker, so the rewards bucket has somewhere to land. The entire token
        // supply sits with the Seeder as one-sided liquidity post-graduation - the
        // only way anyone (including this test) holds any is to buy it.
        address staker = makeAddr("staker");
        deal(WETH, staker, 2 ether);
        vm.startPrank(staker);
        IERC20(WETH).approve(address(swap), type(uint256).max);
        _buyTokenWithWeth(tokenKey, 1 ether);
        MockRouterCheck(token).approve(router.stakingVault(), type(uint256).max);
        HolderStakingVault(router.stakingVault()).stake(MockRouterCheck(token).balanceOf(staker));
        vm.stopPrank();

        _buyTokenWithWeth(tokenKey, 4 ether); // generates a real 1% WETH fee -> owed[router]

        uint256 creatorBefore = IERC20(WETH).balanceOf(realCreator);
        uint256 lockedBefore = ProjectTreasury(treasury).lockedBalance(address(treasuryAsset));
        uint256 burnedBefore = MockRouterCheck(token).balanceOf(DEAD);

        router.route(0, 0, 0, 0);

        assertGt(IERC20(WETH).balanceOf(realCreator) - creatorBefore, 0, "creator bucket paid");
        assertGt(ProjectTreasury(treasury).lockedBalance(address(treasuryAsset)) - lockedBefore, 0, "treasury bucket locked forever");
        assertGt(MockRouterCheck(token).balanceOf(DEAD) - burnedBefore, 0, "buyback bucket burned tokens");
        assertGt(router.totalRoutedToRewards(), 0, "rewards bucket funded the vault");
        assertGt(HolderStakingVault(router.stakingVault()).claimable(staker), 0, "staker has claimable rewards");

        // Treasury deposit is genuinely permanent - no creator-withdrawable balance
        // was created by the fee-router path (only lockedBalance moved).
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)), 0);
    }

    // --------------------------------------------------------------------- //
    //  Slippage: an impossible floor reverts and moves nothing               //
    // --------------------------------------------------------------------- //

    function test_fork_treasurySwap_minOutNotMet_revertsCleanly() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (FeeRouterV2 router, address token,) = _launchViaRouter(1000);
        factory.graduate(token);
        PoolKey memory tokenKey =
            PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});

        vm.prank(realCreator);
        router.scheduleSplit(0, 10000, 0, 0, 0);
        vm.warp(block.timestamp + 7 days);

        _buyTokenWithWeth(tokenKey, 4 ether);

        vm.expectRevert(); // MinAmountOutNotMet
        router.route(0, type(uint256).max, 0, 0);
    }

    // --------------------------------------------------------------------- //
    //  Buyback deferred pre-graduation, flushed once wired                  //
    // --------------------------------------------------------------------- //

    function test_fork_buybackDeferredThenFlushed() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (FeeRouterV2 router, address token,) = _launchViaRouter(1000);

        // Fees can only accrue via a real swap, which needs a seeded pool, which
        // needs graduation - so simulate a pre-graduation fee arrival directly
        // (the deferral logic under test doesn't care WHERE the WETH came from).
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 10000, 0, 0);
        vm.warp(block.timestamp + 7 days);
        deal(WETH, address(router), 1 ether);

        router.route(1 ether, 0, 0, 0);
        assertEq(router.pendingBuybackWeth(), 1 ether);
        assertEq(MockRouterCheck(token).balanceOf(DEAD), 0);

        factory.graduate(token);
        router.wireBuybackPool();
        router.flushDeferredBuyback(0);

        assertEq(router.pendingBuybackWeth(), 0);
        assertGt(MockRouterCheck(token).balanceOf(DEAD), 0);
    }

    // --------------------------------------------------------------------- //
    //  Smoke (review request): scheduled split is inert before the 7-day     //
    //  delay and live after it, and realCreator can deposit into the         //
    //  treasury THROUGH the router (creatorDeposit passthrough).             //
    // --------------------------------------------------------------------- //

    function test_fork_v2_delayedRaise_instantLower_and_creatorDeposit() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // Launch with a non-default initial split (creator 20% / buyback 80%), active
        // from block one, so we can then schedule a creator-RAISE (must be delayed).
        _forceNextLaunchCurrency0();
        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        vm.prank(realCreator);
        (FeeRouterV2 router, address token, address treasury) = routerFactory.createAndLaunch(
            address(hook), WETH, address(MANAGER), address(treasuryAsset), treasuryKey, address(registry),
            1000, 100 ether, 1 hours, DISCLOSURE, address(factory), "Test", "TST", 30 days, "ipfs://test", quoteAssets,
            address(0), 2000, 0, 8000, 0, 0
        );
        assertEq(router.creatorBps(), 2000, "initial split active at block one");
        factory.graduate(token);
        router.wireBuybackPool();

        // Schedule a creator-RAISE (20 -> 50): delayed.
        vm.prank(realCreator);
        router.scheduleSplit(5000, 0, 5000, 0, 0);
        assertTrue(router.hasPendingSplit(), "raise is pending (delayed)");
        assertEq(router.creatorBps(), 2000, "active unchanged at schedule time");
        uint64 effectiveAt = router.pendingEffectiveAt();

        // Before 7 days: still the old split.
        vm.warp(block.timestamp + 2 hours);
        assertLt(block.timestamp, effectiveAt, "inside the 7-day delay");
        router.applySplit();
        assertEq(router.creatorBps(), 2000, "old split before delay");
        assertTrue(router.hasPendingSplit(), "still pending before delay");

        // After 7 days: applies.
        vm.warp(uint256(effectiveAt) + 1);
        router.applySplit();
        assertEq(router.creatorBps(), 5000, "raise active after delay");
        assertFalse(router.hasPendingSplit(), "pending cleared after delay");

        // Instant lowering (50 -> 10): applies immediately, no delay.
        vm.prank(realCreator);
        router.scheduleSplit(1000, 0, 9000, 0, 0);
        assertEq(router.creatorBps(), 1000, "instant lowering applied immediately");
        assertFalse(router.hasPendingSplit(), "no pending after an instant change");

        // realCreator deposits into the treasury THROUGH the router (creator path,
        // creator-withdrawable) - the onlyCreator passthrough still works.
        uint256 depositAmt = 1_000e18;
        treasuryAsset.transfer(realCreator, depositAmt);
        uint256 wdBefore = ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset));
        vm.startPrank(realCreator);
        treasuryAsset.approve(address(router), depositAmt);
        router.creatorDeposit(address(treasuryAsset), depositAmt);
        vm.stopPrank();
        assertEq(
            ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)) - wdBefore,
            depositAmt,
            "creatorDeposit via router credits creator-withdrawable balance"
        );
    }

    // --------------------------------------------------------------------- //
    //  runBasket on a real router launch: basket deposited, buckets intact    //
    // --------------------------------------------------------------------- //

    function test_fork_runBasket_depositsBasket_bucketsIntact_routeStillWorks() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (FeeRouterV2 router, address token, address treasury) = _launchViaRouter(1000);
        factory.graduate(token);
        router.wireBuybackPool();
        PoolKey memory tokenKey =
            PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});

        // Four-way split + a staker so every bucket has somewhere to land.
        vm.prank(realCreator);
        router.scheduleSplit(2500, 2500, 2500, 0, 2500);
        vm.warp(block.timestamp + 7 days);

        address staker = makeAddr("staker");
        deal(WETH, staker, 2 ether);
        vm.startPrank(staker);
        IERC20(WETH).approve(address(swap), type(uint256).max);
        _buyTokenWithWeth(tokenKey, 1 ether);
        MockRouterCheck(token).approve(router.stakingVault(), type(uint256).max);
        HolderStakingVault(router.stakingVault()).stake(MockRouterCheck(token).balanceOf(staker));
        vm.stopPrank();

        // Real fee, then route only a SLICE so the router keeps leftover WETH
        // earmarked for the buckets ("router holds pending bucket funds").
        _buyTokenWithWeth(tokenKey, 4 ether);
        router.route(0.0001 ether, 0, 0, 0);
        uint256 routerWethHeld = IERC20(WETH).balanceOf(address(router));
        assertGt(routerWethHeld, 0, "router holds leftover bucket WETH");

        uint256 c0 = router.totalRoutedToCreator();
        uint256 t0 = router.totalRoutedToTreasury();
        uint256 b0 = router.totalRoutedToBuyback();
        uint256 r0 = router.totalRoutedToRewards();

        // runBasket with two legs (mock mints 100e18 of each to the router).
        BasketLeg[] memory legs = new BasketLeg[](2);
        legs[0] = BasketLeg({asset: address(treasuryAsset), weightBps: 5000, preferFables: false, fablesHopIdx: new uint256[](0), ramsesHopIdx: new uint256[](0), minOut: 1});
        legs[1] = BasketLeg({asset: address(basketAsset2), weightBps: 5000, preferFables: false, fablesHopIdx: new uint256[](0), ramsesHopIdx: new uint256[](0), minOut: 1});

        uint256 wd1Before = ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset));
        uint256 wd2Before = ProjectTreasury(treasury).creatorWithdrawable(address(basketAsset2));

        vm.deal(realCreator, 1 ether);
        vm.prank(realCreator);
        router.runBasket{value: 1 ether}(legs, block.timestamp + 1 hours);

        // Treasury credited EXACTLY the swapped amounts, creator-withdrawable (the
        // route() treasury bucket is LOCKED and tracked separately, so these deltas
        // come only from runBasket).
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)) - wd1Before, 100e18, "leg 1 deposited");
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(basketAsset2)) - wd2Before, 100e18, "leg 2 deposited");

        // runBasket touched NO bucket funds or accounting.
        assertEq(IERC20(WETH).balanceOf(address(router)), routerWethHeld, "bucket WETH untouched");
        assertEq(router.pendingBuybackWeth(), 0, "no pending buyback (pool wired)");
        assertEq(router.totalRoutedToCreator(), c0);
        assertEq(router.totalRoutedToTreasury(), t0);
        assertEq(router.totalRoutedToBuyback(), b0);
        assertEq(router.totalRoutedToRewards(), r0);

        // route() still distributes the held WETH across every bucket.
        vm.warp(block.timestamp + 1 hours);
        router.route(0, 0, 0, 0);
        assertGt(router.totalRoutedToCreator(), c0, "creator bucket still paid");
        assertGt(router.totalRoutedToTreasury(), t0, "treasury bucket still paid");
        assertGt(router.totalRoutedToBuyback(), b0, "buyback bucket still paid");
        assertGt(router.totalRoutedToRewards(), r0, "rewards bucket still paid");
    }

    // ── v2: initial split active from block one; first route after a swap uses it ──
    function test_fork_v2_initialSplitActive_firstRouteUsesIt() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // Launch with a NON-default initial split (2500 each) - no scheduleSplit, no
        // warp anywhere in this test.
        _forceNextLaunchCurrency0();
        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        vm.prank(realCreator);
        (FeeRouterV2 router, address token, address treasury) = routerFactory.createAndLaunch(
            address(hook), WETH, address(MANAGER), address(treasuryAsset), treasuryKey, address(registry),
            1000, 100 ether, 1 hours, DISCLOSURE, address(factory), "Test", "TST", 30 days, "ipfs://test", quoteAssets,
            address(0), 2500, 2500, 2500, 0, 2500
        );
        // Active from block one - no pending, split is live.
        assertEq(router.creatorBps(), 2500, "initial split active at block one");
        assertFalse(router.hasPendingSplit(), "no pending - initial split is immediate");

        factory.graduate(token);
        router.wireBuybackPool();
        PoolKey memory tokenKey =
            PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});

        // Staker so the rewards bucket lands somewhere.
        address staker = makeAddr("staker2");
        deal(WETH, staker, 2 ether);
        vm.startPrank(staker);
        IERC20(WETH).approve(address(swap), type(uint256).max);
        _buyTokenWithWeth(tokenKey, 1 ether);
        MockRouterCheck(token).approve(router.stakingVault(), type(uint256).max);
        HolderStakingVault(router.stakingVault()).stake(MockRouterCheck(token).balanceOf(staker));
        vm.stopPrank();

        uint256 creatorBefore = IERC20(WETH).balanceOf(realCreator);
        _buyTokenWithWeth(tokenKey, 4 ether); // first real fee
        router.route(0, 0, 0, 0); // FIRST route, straight after the first swaps - no warp

        // The initial 25/25/25/25 split was used immediately.
        assertGt(IERC20(WETH).balanceOf(realCreator) - creatorBefore, 0, "creator paid from block-one split");
        assertGt(ProjectTreasury(treasury).lockedBalance(address(treasuryAsset)), 0, "treasury locked from block-one split");
        assertGt(MockRouterCheck(token).balanceOf(DEAD), 0, "buyback burned from block-one split");
        assertGt(router.totalRoutedToRewards(), 0, "rewards funded from block-one split");
    }

    // --------------------------------------------------------------------- //
    //  v2 families: the parentBurn bucket buys a real parent through its WETH //
    //  pool and sends it to the dead address                                 //
    // --------------------------------------------------------------------- //

    function test_fork_family_parentBurn_endToEnd() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // A PARENT: launch + graduate so it has a live WETH pool to buy through.
        (, address parentTok,) = _launchViaRouter(1000);
        factory.graduate(parentTok);

        // A CHILD whose parentBurn bucket targets that parent.
        _forceNextLaunchCurrency0();
        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        vm.prank(realCreator);
        (FeeRouterV2 child, address childTok, address childTreasury) = routerFactory.createAndLaunch(
            address(hook), WETH, address(MANAGER), address(treasuryAsset), treasuryKey, address(registry),
            1000, 100 ether, 1 hours, DISCLOSURE, address(factory), "Child", "CHD", 30 days, "ipfs://c", quoteAssets,
            parentTok, 2500, 2500, 2500, 2500, 0
        );
        assertEq(child.parent(), parentTok, "child wired to parent");

        factory.graduate(childTok);
        child.wireBuybackPool();
        child.wireParentPool(); // parent is graduated AND has a live WETH pool

        PoolKey memory childKey =
            PoolKey({currency0: Currency.wrap(childTok), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});
        _buyTokenWithWeth(childKey, 4 ether); // real 1% WETH fee -> owed[child]

        uint256 parentBurnedBefore = IERC20(parentTok).balanceOf(DEAD);
        uint256 childBurnedBefore = IERC20(childTok).balanceOf(DEAD);

        child.route(0, 0, 0, 0);

        assertGt(IERC20(parentTok).balanceOf(DEAD) - parentBurnedBefore, 0, "parent bought and burned");
        assertGt(child.totalParentBurned(), 0, "parent-burn total recorded");
        assertGt(IERC20(childTok).balanceOf(DEAD) - childBurnedBefore, 0, "child buyback still burns child");
        assertGt(ProjectTreasury(childTreasury).lockedBalance(address(treasuryAsset)), 0, "treasury bucket locked");
    }

    function test_fork_family_parentBurnDeferredThenFlushed() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (, address parentTok,) = _launchViaRouter(1000);
        factory.graduate(parentTok);

        _forceNextLaunchCurrency0();
        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        vm.prank(realCreator);
        (FeeRouterV2 child, address childTok,) = routerFactory.createAndLaunch(
            address(hook), WETH, address(MANAGER), address(treasuryAsset), treasuryKey, address(registry),
            1000, 100 ether, 1 hours, DISCLOSURE, address(factory), "Child", "CHD", 30 days, "ipfs://c", quoteAssets,
            parentTok, 0, 0, 0, 10000, 0
        );
        // Child not graduated + parent pool not wired yet → route defers the share.
        deal(WETH, address(child), 1 ether);
        child.route(1 ether, 0, 0, 0);
        assertEq(child.pendingParentBurnWeth(), 1 ether);
        assertEq(IERC20(parentTok).balanceOf(DEAD), 0);

        // wireParentPool needs only the PARENT graduated (child need not be).
        child.wireParentPool();
        child.flushDeferredParentBurn(0);
        assertEq(child.pendingParentBurnWeth(), 0);
        assertGt(IERC20(parentTok).balanceOf(DEAD), 0);
        assertGt(child.totalParentBurned(), 0);
        assertFalse(factory.graduated(childTok), "child never graduated in this test");
    }
}

/// @dev Minimal fixed-price Chainlink feed for the ETH/USD leg BallastFactory
///      requires at construction - WETH-quoted launches never actually read it
///      (see BallastFactory._p0Tick), but the constructor still needs an address.
contract FixedFeed {
    uint8 public constant decimals = 8;
    int256 internal immutable _answer;
    uint256 internal immutable _updatedAt;

    constructor(int256 answer_, uint256 updatedAt_) {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}

/// @dev BallastToken's full ABI isn't needed here, just what this file reads.
interface MockRouterCheck {
    function creator() external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
