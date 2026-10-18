// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {FeeRouterV2} from "../src/FeeRouterV2.sol";
import {BasketLeg} from "../src/FeeRouter.sol";
import {HolderStakingVault} from "../src/HolderStakingVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeHook} from "./mocks/MockFeeHook.sol";
import {MockRouterFactory} from "./mocks/MockRouterFactory.sol";
import {MockRouterToken} from "./mocks/MockRouterToken.sol";
import {MockBasketZap} from "./mocks/MockBasketZap.sol";

/// @dev SCOPE - same split as BuybackBurnerV2.t.sol/BuybackBurnerV2Fork.t.sol. This
///      file proves FeeRouterV2's OWN logic (wiring, access control, split math,
///      bucket routing for the non-swap buckets, the v2 asymmetric delay + initial
///      split + parent-burn family rules, passthroughs) against a mocked
///      Hook/Factory and the REAL ProjectTreasury/AssetRegistry. It deliberately
///      does NOT exercise the treasury/buyback/parent PoolManager swap path - that
///      needs a real pool and is proven in FeeRouterV2Fork.t.sol against gen-4's
///      real live pools, exactly like BuybackBurnerV2's split.
contract FeeRouterV2Test is Test {
    uint256 constant BPS = 10_000;
    uint256 constant NOTICE = 30 days;
    bytes32 constant DISCLOSURE = keccak256("fee-router v1: auto-routed trading fee, permanently locked, no claim");

    AssetRegistry registry;
    MockERC20 weth;
    MockERC20 treasuryAsset;
    MockFeeHook hook;
    MockRouterFactory factory;
    MockBasketZap mockZap;
    MockRouterToken parentToken; // a registered "Ballast-launched" parent for family tests

    address poolManager = makeAddr("poolManager"); // never called in these tests
    address realCreator = makeAddr("realCreator");
    address stranger = makeAddr("stranger");
    address owner = makeAddr("registryOwner");

    function setUp() public {
        registry = new AssetRegistry(owner);
        weth = new MockERC20("WETH", "WETH", 18);
        treasuryAsset = new MockERC20("SGOV", "SGOV", 18);
        vm.prank(owner);
        registry.setAsset(address(treasuryAsset), address(0xFEED), 1 days, 1e18);

        hook = new MockFeeHook(weth);
        factory = new MockRouterFactory(address(registry));
        mockZap = new MockBasketZap(10e18); // mints 10 of each leg asset to the router

        // A standalone token marked Ballast-launched in the mock factory, to stand in
        // as a family PARENT. Not wired to any router here.
        parentToken = new MockRouterToken(realCreator);
        factory.registerLaunch(address(parentToken));
    }

    function _zeroTreasuryKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(address(0)), fee: 0, tickSpacing: 60, hooks: IHooks(address(0))});
    }

    function _deployRouter(address treasuryAsset_) internal returns (FeeRouterV2 router) {
        router = new FeeRouterV2(
            realCreator,
            address(factory),
            address(hook),
            address(weth),
            poolManager,
            treasuryAsset_,
            _zeroTreasuryKey(),
            address(registry),
            1000, // 10% slippage
            100 ether, // maxRoutePerCall
            1 hours, // routeCooldown
            DISCLOSURE,
            address(mockZap),
            address(0), // no parent
            10000, // initial split: 100% creator (v1-equivalent default)
            0,
            0,
            0,
            0
        );
    }

    // Deploy + launch with a CUSTOM initial split (v2) - active from block one.
    function _wiredRouterWithSplit(address treasuryAsset_, uint16 c, uint16 t, uint16 b, uint16 r)
        internal
        returns (FeeRouterV2 router, address token, address treasury)
    {
        router = new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, treasuryAsset_,
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            address(0), c, t, b, 0, r
        );
        vm.prank(realCreator);
        (token, treasury) = router.launchNew("Test", "TST", NOTICE, "ipfs://x", new address[](1));
    }

    // Deploy + launch with a parent + a parentBurn initial split (family).
    function _wiredRouterWithParent(address parent_, uint16 c, uint16 b, uint16 pb, uint16 r)
        internal
        returns (FeeRouterV2 router, address token, address treasury)
    {
        router = new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            parent_, c, 0, b, pb, r
        );
        vm.prank(realCreator);
        (token, treasury) = router.launchNew("Child", "CHD", NOTICE, "ipfs://x", new address[](1));
    }

    function _wiredRouter() internal returns (FeeRouterV2 router, address token, address treasury) {
        router = _deployRouter(address(0));
        vm.prank(realCreator);
        (token, treasury) = router.launchNew("Test", "TST", NOTICE, "ipfs://x", new address[](1));
    }

    // --------------------------------------------------------------------- //
    //  Constructor                                                           //
    // --------------------------------------------------------------------- //

    function test_constructor_zeroAddress_reverts() public {
        vm.expectRevert(FeeRouterV2.ZeroAddress.selector);
        new FeeRouterV2(address(0), address(factory), address(hook), address(weth), poolManager, address(0), _zeroTreasuryKey(), address(registry), 1000, 1 ether, 1 hours, DISCLOSURE, address(mockZap), address(0), 10000, 0, 0, 0, 0);
    }

    function test_constructor_slippageAboveCeiling_reverts() public {
        vm.expectRevert(FeeRouterV2.BadSplit.selector);
        new FeeRouterV2(realCreator, address(factory), address(hook), address(weth), poolManager, address(0), _zeroTreasuryKey(), address(registry), 2001, 1 ether, 1 hours, DISCLOSURE, address(mockZap), address(0), 10000, 0, 0, 0, 0);
    }

    function test_constructor_treasuryAssetNotAllowlisted_reverts() public {
        MockERC20 notAllowed = new MockERC20("X", "X", 18);
        vm.expectRevert(FeeRouterV2.TreasuryBucketDisabled.selector);
        new FeeRouterV2(realCreator, address(factory), address(hook), address(weth), poolManager, address(notAllowed), _zeroTreasuryKey(), address(registry), 1000, 1 ether, 1 hours, DISCLOSURE, address(mockZap), address(0), 10000, 0, 0, 0, 0);
    }

    function test_constructor_defaultSplitIs100PercentCreator() public {
        FeeRouterV2 router = _deployRouter(address(0));
        assertEq(router.creatorBps(), BPS);
        assertEq(router.treasuryBps(), 0);
        assertEq(router.buybackBps(), 0);
        assertEq(router.parentBurnBps(), 0);
        assertEq(router.rewardsBps(), 0);
        assertEq(router.parent(), address(0));
    }

    function test_noOwnerGatedFunctionExists() public {
        // No Ownable import anywhere in FeeRouterV2 - the only privileged address is
        // realCreator, scoped to the specific functions tested below, not a
        // catch-all admin role.
        FeeRouterV2 router = _deployRouter(address(0));
        assertEq(router.realCreator(), realCreator);
    }

    // --------------------------------------------------------------------- //
    //  Wiring                                                                //
    // --------------------------------------------------------------------- //

    function test_launchNew_onlyRealCreatorOrDeployer() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.prank(stranger);
        vm.expectRevert(FeeRouterV2.NotAuthorized.selector);
        router.launchNew("T", "T", NOTICE, "", new address[](1));
    }

    function test_launchNew_wiresTokenTreasuryAndVault() public {
        (FeeRouterV2 router, address token, address treasury) = _wiredRouter();
        assertTrue(router.wired());
        assertEq(router.token(), token);
        assertEq(router.treasury(), treasury);
        assertTrue(router.stakingVault() != address(0));
        assertEq(HolderStakingVault(router.stakingVault()).router(), address(router));
        assertEq(MockRouterToken(token).creator(), address(router)); // router IS on-chain creator
        assertEq(ProjectTreasury(treasury).creator(), address(router));
    }

    function test_launchNew_secondCall_reverts() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.AlreadyWired.selector);
        router.launchNew("T", "T", NOTICE, "", new address[](1));
    }

    function test_adopt_onlyRealCreator() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.prank(stranger);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.adopt(address(0x1), address(0x2));
    }

    function test_adopt_rejectsTreasuryBucketConfigured() public {
        FeeRouterV2 router = _deployRouter(address(treasuryAsset));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.TreasuryBucketDisabled.selector);
        router.adopt(address(0x1), address(0x2));
    }

    function test_adopt_rejectsWrongCreator() public {
        FeeRouterV2 router = _deployRouter(address(0));
        MockRouterToken token = new MockRouterToken(stranger); // creator() = stranger, not realCreator
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.NotTokenCreator.selector);
        router.adopt(address(token), address(0x2));
    }

    function test_adopt_wiresWithoutBecomingOnChainCreator() public {
        FeeRouterV2 router = _deployRouter(address(0));
        MockRouterToken token = new MockRouterToken(realCreator);
        ProjectTreasury treasury = new ProjectTreasury(address(token), realCreator, NOTICE, address(registry));
        vm.prank(realCreator);
        token.setTreasury(address(treasury));
        vm.prank(realCreator);
        router.adopt(address(token), address(treasury));
        assertTrue(router.wired());
        assertEq(MockRouterToken(token).creator(), realCreator); // unchanged - router never became creator
    }

    // --------------------------------------------------------------------- //
    //  Split scheduling                                                     //
    // --------------------------------------------------------------------- //

    function test_scheduleSplit_onlyRealCreator() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.scheduleSplit(10000, 0, 0, 0, 0);
    }

    function test_scheduleSplit_badSum_reverts() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.BadSplit.selector);
        router.scheduleSplit(5000, 0, 0, 0, 0);
    }

    function test_scheduleSplit_treasuryBpsWithoutAsset_reverts() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.TreasuryBucketDisabled.selector);
        router.scheduleSplit(0, 10000, 0, 0, 0);
    }

    function test_scheduleSplit_parentBurnBpsWithoutParent_reverts() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.ParentRequired.selector);
        router.scheduleSplit(0, 0, 0, 10000, 0);
    }

    // ── v2 asymmetric delay ──────────────────────────────────────────────── //

    event SplitAppliedInstant(uint16 creatorBps, uint16 treasuryBps, uint16 buybackBps, uint16 parentBurnBps, uint16 rewardsBps, bool cancelledPending);

    function test_v2_loweringCreatorShareIsInstant() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 0, 0, 10000); // creator 100→0, rewards up → instant
        assertEq(router.creatorBps(), 0);
        assertEq(router.rewardsBps(), 10000);
        assertFalse(router.hasPendingSplit());
    }

    function test_v2_raisingCreatorShareIsDelayed() public {
        (FeeRouterV2 router,,) = _wiredRouterWithSplit(address(0), 2000, 0, 0, 8000);
        vm.prank(realCreator);
        router.scheduleSplit(5000, 0, 0, 0, 5000); // creator 20→50 UP → delayed
        assertEq(router.creatorBps(), 2000); // unchanged
        assertTrue(router.hasPendingSplit());
        assertEq(router.pendingCreatorBps(), 5000);
        vm.warp(block.timestamp + 7 days);
        router.applySplit();
        assertEq(router.creatorBps(), 5000);
        assertFalse(router.hasPendingSplit());
    }

    function test_v2_bucketToBucketShiftIsDelayed() public {
        (FeeRouterV2 router,,) = _wiredRouterWithSplit(address(0), 2000, 0, 4000, 4000);
        vm.prank(realCreator);
        router.scheduleSplit(2000, 0, 6000, 0, 2000); // creator same, buyback up, rewards DOWN → delayed
        assertEq(router.buybackBps(), 4000); // unchanged (still pending)
        assertTrue(router.hasPendingSplit());
    }

    function test_v2_instantChangeCancelsPending() public {
        (FeeRouterV2 router,,) = _wiredRouterWithSplit(address(0), 2000, 0, 4000, 4000);
        vm.startPrank(realCreator);
        router.scheduleSplit(5000, 0, 2500, 0, 2500); // raises creator → delayed (pending)
        assertTrue(router.hasPendingSplit());
        // Now a creator-lowering change: instant, and it wipes the pending one.
        router.scheduleSplit(1000, 0, 4500, 0, 4500); // creator 20→10 down, others up → instant
        vm.stopPrank();
        assertEq(router.creatorBps(), 1000);
        assertEq(router.buybackBps(), 4500);
        assertEq(router.rewardsBps(), 4500);
        assertFalse(router.hasPendingSplit());
    }

    function test_v2_instantEmitsEventWithCancelledFlag() public {
        (FeeRouterV2 router,,) = _wiredRouterWithSplit(address(0), 2000, 0, 4000, 4000);
        vm.startPrank(realCreator);
        router.scheduleSplit(5000, 0, 2500, 0, 2500); // pending
        vm.expectEmit(false, false, false, true);
        emit SplitAppliedInstant(1000, 0, 4500, 0, 4500, true); // cancelledPending = true
        router.scheduleSplit(1000, 0, 4500, 0, 4500);
        vm.stopPrank();
    }

    function test_v2_reassertingCurrentSplitInstantlyCancelsPending() public {
        // Edge: a pending (delayed) change can be wiped by re-asserting the current
        // active split - creator==, every other== → qualifies as instant (all >=).
        (FeeRouterV2 router,,) = _wiredRouterWithSplit(address(0), 2000, 0, 4000, 4000);
        vm.startPrank(realCreator);
        router.scheduleSplit(5000, 0, 2500, 0, 2500); // delayed pending
        assertTrue(router.hasPendingSplit());
        router.scheduleSplit(2000, 0, 4000, 0, 4000); // same as active → instant no-op, cancels pending
        vm.stopPrank();
        assertFalse(router.hasPendingSplit());
        assertEq(router.creatorBps(), 2000);
    }

    function test_v2_onlyRealCreatorForInstantPath() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.prank(stranger);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.scheduleSplit(0, 0, 0, 0, 10000); // would be instant, but stranger blocked
    }

    function test_v2_parentBurnDownIsDelayed() public {
        // Shifting value OUT of the parentBurn bucket (parentBurn down) is not a pure
        // move away from the creator → delayed, even if creator is unchanged.
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 2000, 0, 4000, 4000);
        vm.prank(realCreator);
        router.scheduleSplit(2000, 0, 4000, 0, 4000); // parentBurn 4000→0, rewards up → delayed
        assertEq(router.parentBurnBps(), 4000); // unchanged
        assertTrue(router.hasPendingSplit());
    }

    function test_v2_parentBurnUpWithCreatorDownIsInstant() public {
        // creator down, parentBurn up, every other bucket >= current → instant.
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 5000, 0, 2500, 2500);
        vm.prank(realCreator);
        router.scheduleSplit(2000, 0, 0, 5500, 2500); // creator 50→20 down, parentBurn 25→55 up → instant
        assertEq(router.creatorBps(), 2000);
        assertEq(router.parentBurnBps(), 5500);
        assertFalse(router.hasPendingSplit());
    }

    // ── v2 initial split (active from block one) ─────────────────────────── //

    function test_v2_initialSplit_activeImmediately() public {
        (FeeRouterV2 router,,) = _wiredRouterWithSplit(address(0), 1000, 0, 3500, 5500);
        assertEq(router.creatorBps(), 1000);
        assertEq(router.buybackBps(), 3500);
        assertEq(router.rewardsBps(), 5500);
        assertFalse(router.hasPendingSplit()); // no delay for the launch split
    }

    function test_v2_initialSplit_badSum_reverts() public {
        vm.expectRevert(FeeRouterV2.BadSplit.selector);
        new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            address(0), 1000, 0, 0, 0, 0
        );
    }

    function test_v2_initialSplit_treasuryWithoutAsset_reverts() public {
        vm.expectRevert(FeeRouterV2.TreasuryBucketDisabled.selector);
        new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            address(0), 5000, 5000, 0, 0, 0
        );
    }

    function test_v2_initialSplit_routeUsesItWithoutScheduleOrWarp() public {
        (FeeRouterV2 router,,) = _wiredRouterWithSplit(address(0), 0, 0, 0, 10000); // 100% rewards from block one
        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0, 0); // no scheduleSplit, no warp
        assertEq(weth.balanceOf(router.stakingVault()), 1 ether);
        assertEq(weth.balanceOf(realCreator), 0);
    }

    // --------------------------------------------------------------------- //
    //  Families — parent / parentBurn bucket                                 //
    // --------------------------------------------------------------------- //

    event ParentSet(address indexed parent);

    function test_family_constructor_parentBurnWithoutParent_reverts() public {
        vm.expectRevert(FeeRouterV2.ParentRequired.selector);
        new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            address(0), 0, 0, 0, 5000, 5000 // parentBurn 5000 but no parent
        );
    }

    function test_family_constructor_nonBallastParent_reverts() public {
        MockRouterToken notLaunched = new MockRouterToken(realCreator); // never registered
        vm.expectRevert(FeeRouterV2.NotBallastParent.selector);
        new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            address(notLaunched), 5000, 0, 0, 5000, 0
        );
    }

    function test_family_constructor_emitsParentSet() public {
        vm.expectEmit(true, false, false, false);
        emit ParentSet(address(parentToken));
        new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            address(parentToken), 5000, 0, 0, 5000, 0
        );
    }

    function test_family_parentImmutableSet() public {
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 5000, 0, 2500, 2500);
        assertEq(router.parent(), address(parentToken));
        assertEq(router.parentBurnBps(), 2500);
    }

    function test_family_parentEqualsSelf_rejectedAtWire() public {
        // Deploy a router whose parent is parentToken, then adopt that SAME token →
        // _wire sees token == parent and reverts ParentIsSelf.
        FeeRouterV2 router = new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(mockZap),
            address(parentToken), 10000, 0, 0, 0, 0
        );
        // parentToken.creator() == realCreator, give it a treasury so adopt's checks pass.
        ProjectTreasury tr = new ProjectTreasury(address(parentToken), realCreator, NOTICE, address(registry));
        vm.prank(realCreator);
        parentToken.setTreasury(address(tr));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.ParentIsSelf.selector);
        router.adopt(address(parentToken), address(tr));
    }

    function test_family_routeParentBurnBeforeWired_defers() public {
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 0, 0, 10000, 0);
        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0, 0);
        assertEq(router.pendingParentBurnWeth(), 1 ether);
        assertEq(router.totalRoutedToParentBurn(), 0); // not yet executed
        assertEq(router.parentWired(), false);
    }

    function test_family_wireParentPool_noParent_reverts() public {
        (FeeRouterV2 router,,) = _wiredRouter(); // parent == address(0)
        vm.expectRevert(FeeRouterV2.ParentRequired.selector);
        router.wireParentPool();
    }

    function test_family_wireParentPool_parentNotGraduated_reverts() public {
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 5000, 0, 2500, 2500);
        // parentToken registered but not graduated → ParentPoolNotReady (reverts
        // before any PoolManager read, so safe with the dummy poolManager).
        vm.expectRevert(FeeRouterV2.ParentPoolNotReady.selector);
        router.wireParentPool();
    }

    function test_family_flushDeferredParentBurn_notWired_reverts() public {
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 0, 0, 10000, 0);
        vm.expectRevert(FeeRouterV2.ParentNotWired.selector);
        router.flushDeferredParentBurn(0);
    }

    function test_family_scheduleSplit_parentBurnAllowedWithParent() public {
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 10000, 0, 0, 0);
        // Pure move away from creator (creator down, parentBurn up) → instant.
        vm.prank(realCreator);
        router.scheduleSplit(4000, 0, 0, 6000, 0);
        assertEq(router.parentBurnBps(), 6000);
        assertFalse(router.hasPendingSplit());
    }

    // --------------------------------------------------------------------- //
    //  route() - creator bucket (no swap needed)                            //
    // --------------------------------------------------------------------- //

    function test_route_notWired_reverts() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.expectRevert(FeeRouterV2.NotWired.selector);
        router.route(0, 0, 0, 0);
    }

    function test_route_nothingToRoute_reverts() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.expectRevert(FeeRouterV2.NothingToRoute.selector);
        router.route(0, 0, 0, 0);
    }

    function test_route_defaultSplit_allToCreator() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        hook.credit(address(router), 1 ether);

        router.route(0, 0, 0, 0);

        assertEq(weth.balanceOf(realCreator), 1 ether);
        assertEq(router.totalRoutedToCreator(), 1 ether);
    }

    function test_route_capsAtMaxRoutePerCall() public {
        // Re-deploy with a tiny cap to exercise the clamp.
        FeeRouterV2 router = new FeeRouterV2(realCreator, address(factory), address(hook), address(weth), poolManager, address(0), _zeroTreasuryKey(), address(registry), 1000, 1 ether, 1 hours, DISCLOSURE, address(mockZap), address(0), 10000, 0, 0, 0, 0);
        vm.prank(realCreator);
        router.launchNew("T", "T", NOTICE, "", new address[](1));
        hook.credit(address(router), 5 ether);

        router.route(0, 0, 0, 0);

        assertEq(weth.balanceOf(realCreator), 1 ether); // capped, not the full 5
        assertEq(weth.balanceOf(address(router)), 4 ether); // remainder stays for the next call
    }

    function test_route_cooldown_blocksImmediateSecondCall() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        hook.credit(address(router), 2 ether);
        router.route(1 ether, 0, 0, 0);

        hook.credit(address(router), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(FeeRouterV2.Cooldown.selector, router.readyAt()));
        router.route(0, 0, 0, 0);
    }

    function test_route_afterCooldown_succeeds() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0, 0);

        hook.credit(address(router), 1 ether);
        vm.warp(block.timestamp + 1 hours);
        router.route(0, 0, 0, 0);

        assertEq(router.totalRoutedToCreator(), 2 ether);
    }

    // --------------------------------------------------------------------- //
    //  route() - rounding + 0/100% edges across creator/rewards             //
    // --------------------------------------------------------------------- //

    function test_route_rewardsBucket_100Percent() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 0, 0, 10000);
        vm.warp(block.timestamp + 7 days);

        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0, 0);

        address vault = router.stakingVault();
        assertEq(weth.balanceOf(vault), 1 ether);
        assertEq(router.totalRoutedToRewards(), 1 ether);
        assertEq(weth.balanceOf(realCreator), 0);
    }

    function test_route_splitRounding_remainderGoesToRewards() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        // 33/0/0/0/67 of an amount not evenly divisible by 3 exercises truncation.
        vm.prank(realCreator);
        router.scheduleSplit(3333, 0, 0, 0, 6667);
        vm.warp(block.timestamp + 7 days);

        hook.credit(address(router), 100); // 100 wei, deliberately tiny/indivisible
        router.route(0, 0, 0, 0);

        uint256 toCreator = (100 * 3333) / BPS; // = 33
        uint256 toRewards = 100 - toCreator; // = 67 (remainder, not 100*6667/10000=66)
        assertEq(weth.balanceOf(realCreator), toCreator);
        assertEq(weth.balanceOf(router.stakingVault()), toRewards);
        assertEq(toCreator + toRewards, 100); // no wei lost
    }

    function test_route_fiveBucketSplit_alwaysSumsToTotal() public {
        // Five non-zero buckets (creator/buyback/parentBurn/rewards; treasury stays
        // 0 - disabled here) with an indivisible amount: remainder lands in rewards,
        // nothing lost. Buyback/parentBurn defer (pools unwired) so their WETH stays
        // on the router and is countable.
        (FeeRouterV2 router,,) = _wiredRouterWithParent(address(parentToken), 2001, 3000, 3000, 1999);
        hook.credit(address(router), 7);
        router.route(0, 0, 0, 0);

        uint256 toCreator = (7 * 2001) / BPS; // 1
        uint256 toBuyback = (7 * 3000) / BPS; // 2 → deferred
        uint256 toParent = (7 * 3000) / BPS; // 2 → deferred
        uint256 toRewards = 7 - toCreator - toBuyback - toParent; // remainder = 2
        assertEq(weth.balanceOf(realCreator), toCreator);
        assertEq(router.pendingBuybackWeth(), toBuyback);
        assertEq(router.pendingParentBurnWeth(), toParent);
        assertEq(weth.balanceOf(router.stakingVault()), toRewards);
        assertEq(toCreator + toBuyback + toParent + toRewards, 7); // no wei lost
    }

    // --------------------------------------------------------------------- //
    //  Buyback bucket - deferral before the pool is wired                   //
    // --------------------------------------------------------------------- //

    function test_route_buybackBeforeWired_defersRatherThanReverting() public {
        (FeeRouterV2 router, address token,) = _wiredRouter();
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 10000, 0, 0);
        vm.warp(block.timestamp + 7 days);

        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0, 0);

        assertEq(router.pendingBuybackWeth(), 1 ether);
        assertEq(router.totalRoutedToBuyback(), 0); // not yet executed
        assertEq(weth.balanceOf(token), 0);
    }

    function test_wireBuybackPool_notWired_reverts() public {
        FeeRouterV2 router = _deployRouter(address(0));
        vm.expectRevert(FeeRouterV2.NotWired.selector);
        router.wireBuybackPool();
    }

    function test_wireBuybackPool_notGraduated_reverts() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.expectRevert(FeeRouterV2.NotGraduated.selector);
        router.wireBuybackPool();
    }

    function test_wireBuybackPool_success_ordersCurrenciesByAddress() public {
        (FeeRouterV2 router, address token,) = _wiredRouter();
        factory.setGraduated(token, true);
        router.wireBuybackPool();
        assertTrue(router.buybackWired());
        PoolKey memory key = router.buybackPoolKey();
        (address lower, address higher) = token < address(weth) ? (token, address(weth)) : (address(weth), token);
        assertEq(Currency.unwrap(key.currency0), lower);
        assertEq(Currency.unwrap(key.currency1), higher);
        assertEq(key.fee, 0);
        assertEq(key.tickSpacing, 60);
    }

    function test_flushDeferredBuyback_notWired_reverts() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.expectRevert(FeeRouterV2.BuybackNotWired.selector);
        router.flushDeferredBuyback(0);
    }

    // --------------------------------------------------------------------- //
    //  routeIn - non-WETH currencies (inert until a non-WETH pool exists)   //
    // --------------------------------------------------------------------- //

    function test_routeIn_rejectsWeth() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.expectRevert(FeeRouterV2.UseRouteForWeth.selector);
        router.routeIn(address(weth));
    }

    function test_routeIn_paysEntireAmountToCreator() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        MockERC20 nvda = new MockERC20("NVDA", "NVDA", 18);
        hook.creditIn(address(router), address(nvda), 5 ether);

        router.routeIn(address(nvda));

        assertEq(nvda.balanceOf(realCreator), 5 ether);
    }

    // --------------------------------------------------------------------- //
    //  Creator/Treasury passthroughs                                        //
    // --------------------------------------------------------------------- //

    function test_passthroughs_onlyRealCreator() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.startPrank(stranger);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.acceptDeposit(1);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.declineDeposit(1);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.announceWithdrawal(address(treasuryAsset), 1);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.executeWithdrawal(1);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.cancelWithdrawal(1);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.setMetadataURI("ipfs://evil");
        vm.stopPrank();
    }

    function test_creatorDeposit_and_withdrawal_roundTrip() public {
        (FeeRouterV2 router,, address treasury) = _wiredRouter();
        treasuryAsset.mint(realCreator, 10 ether);

        vm.startPrank(realCreator);
        treasuryAsset.approve(address(router), 10 ether);
        router.creatorDeposit(address(treasuryAsset), 10 ether);
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)), 10 ether);

        uint256 id = router.announceWithdrawal(address(treasuryAsset), 4 ether);
        vm.warp(block.timestamp + NOTICE);
        router.executeWithdrawal(id);
        vm.stopPrank();

        // ProjectTreasury pays out to `creator` (the router) - passthrough must
        // sweep it straight to realCreator, not strand it in the router.
        assertEq(treasuryAsset.balanceOf(realCreator), 4 ether);
        assertEq(treasuryAsset.balanceOf(address(router)), 0);
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)), 6 ether);
    }

    function test_setMetadataURI_passthrough() public {
        (FeeRouterV2 router, address token,) = _wiredRouter();
        vm.prank(realCreator);
        router.setMetadataURI("ipfs://new");
        assertEq(MockRouterToken(token).metadataURI(), "ipfs://new");
    }

    // --------------------------------------------------------------------- //
    //  runBasket - one-tx basket + adversarial bucket-safety                 //
    // --------------------------------------------------------------------- //

    function _oneLeg(address asset) internal pure returns (BasketLeg[] memory legs) {
        legs = new BasketLeg[](1);
        legs[0] = BasketLeg({
            asset: asset,
            weightBps: 10000,
            preferFables: false,
            fablesHopIdx: new uint256[](0),
            ramsesHopIdx: new uint256[](0),
            minOut: 1
        });
    }

    function test_runBasket_onlyRealCreator() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(FeeRouterV2.NotRealCreator.selector);
        router.runBasket{value: 1 ether}(_oneLeg(address(treasuryAsset)), block.timestamp + 1 hours);
    }

    function test_runBasket_zapNotSet_reverts() public {
        FeeRouterV2 router = new FeeRouterV2(
            realCreator, address(factory), address(hook), address(weth), poolManager, address(0),
            _zeroTreasuryKey(), address(registry), 1000, 100 ether, 1 hours, DISCLOSURE, address(0),
            address(0), 10000, 0, 0, 0, 0
        );
        vm.prank(realCreator);
        router.launchNew("T", "T", NOTICE, "", new address[](1));
        vm.deal(realCreator, 1 ether);
        vm.prank(realCreator);
        vm.expectRevert(FeeRouterV2.BasketZapNotSet.selector);
        router.runBasket{value: 1 ether}(_oneLeg(address(treasuryAsset)), block.timestamp + 1 hours);
    }

    function test_runBasket_rejectsWethLeg() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.deal(realCreator, 1 ether);
        vm.prank(realCreator);
        vm.expectRevert(abi.encodeWithSelector(FeeRouterV2.BadBasketAsset.selector, address(weth)));
        router.runBasket{value: 1 ether}(_oneLeg(address(weth)), block.timestamp + 1 hours);
    }

    function test_runBasket_rejectsLaunchTokenLeg() public {
        (FeeRouterV2 router, address token,) = _wiredRouter();
        vm.deal(realCreator, 1 ether);
        vm.prank(realCreator);
        vm.expectRevert(abi.encodeWithSelector(FeeRouterV2.BadBasketAsset.selector, token));
        router.runBasket{value: 1 ether}(_oneLeg(token), block.timestamp + 1 hours);
    }

    function test_runBasket_depositsOnlyDelta_bucketWethUntouched() public {
        (FeeRouterV2 router,, address treasury) = _wiredRouter();
        // Give the router WETH it is holding for the buyback bucket (deferred).
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 10000, 0, 0);
        vm.warp(block.timestamp + 7 days);
        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0, 0);
        assertEq(router.pendingBuybackWeth(), 1 ether);
        assertEq(weth.balanceOf(address(router)), 1 ether);

        uint256 wdBefore = ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset));
        vm.deal(realCreator, 1 ether);
        vm.prank(realCreator);
        router.runBasket{value: 1 ether}(_oneLeg(address(treasuryAsset)), block.timestamp + 1 hours);

        // Only the swap's delta (10e18, minted by the mock) was deposited, and it's
        // creator-withdrawable (plain deposit), NOT the locked route() bucket.
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)) - wdBefore, 10e18);
        // The WETH the router held for the buyback bucket is completely untouched.
        assertEq(weth.balanceOf(address(router)), 1 ether);
        assertEq(router.pendingBuybackWeth(), 1 ether);
    }

    function test_runBasket_leavesStakingRewardsUntouched() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 0, 0, 10000);
        vm.warp(block.timestamp + 7 days);
        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0, 0);
        address vault = router.stakingVault();
        assertEq(weth.balanceOf(vault), 1 ether);

        vm.deal(realCreator, 1 ether);
        vm.prank(realCreator);
        router.runBasket{value: 1 ether}(_oneLeg(address(treasuryAsset)), block.timestamp + 1 hours);

        assertEq(weth.balanceOf(vault), 1 ether); // rewards already streamed out - untouched
    }

    function test_runBasket_refundsLeftoverEthToRealCreator() public {
        (FeeRouterV2 router,,) = _wiredRouter();
        mockZap.setRefund(0.3 ether); // mock refunds 0.3 of the 1 ether it receives
        vm.deal(realCreator, 1 ether);
        uint256 before = realCreator.balance;
        vm.prank(realCreator);
        router.runBasket{value: 1 ether}(_oneLeg(address(treasuryAsset)), block.timestamp + 1 hours);
        // Net: paid 1 ETH in, 0.3 refunded straight back to realCreator (not stranded).
        assertEq(realCreator.balance, before - 1 ether + 0.3 ether);
        assertEq(address(router).balance, 0);
    }
}
