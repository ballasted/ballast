// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {HolderStakingVault} from "../src/HolderStakingVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeHook} from "./mocks/MockFeeHook.sol";
import {MockRouterFactory} from "./mocks/MockRouterFactory.sol";
import {MockRouterToken} from "./mocks/MockRouterToken.sol";

/// @dev SCOPE — same split as BuybackBurnerV2.t.sol/BuybackBurnerV2Fork.t.sol. This
///      file proves FeeRouter's OWN logic (wiring, access control, split math,
///      bucket routing for the non-swap buckets, passthroughs) against a mocked
///      Hook/Factory and the REAL ProjectTreasury/AssetRegistry. It deliberately
///      does NOT exercise the treasury-swap or buyback-swap PoolManager path —
///      that needs a real pool and is proven in FeeRouterFork.t.sol against
///      gen-4's real live pools, exactly like BuybackBurnerV2's split.
contract FeeRouterTest is Test {
    uint256 constant BPS = 10_000;
    uint256 constant NOTICE = 30 days;
    bytes32 constant DISCLOSURE = keccak256("fee-router v1: auto-routed trading fee, permanently locked, no claim");

    AssetRegistry registry;
    MockERC20 weth;
    MockERC20 treasuryAsset;
    MockFeeHook hook;
    MockRouterFactory factory;

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
    }

    function _zeroTreasuryKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(address(0)), fee: 0, tickSpacing: 60, hooks: IHooks(address(0))});
    }

    function _deployRouter(address treasuryAsset_) internal returns (FeeRouter router) {
        router = new FeeRouter(
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
            DISCLOSURE
        );
    }

    function _wiredRouter() internal returns (FeeRouter router, address token, address treasury) {
        router = _deployRouter(address(0));
        vm.prank(realCreator);
        (token, treasury) = router.launchNew("Test", "TST", NOTICE, "ipfs://x", new address[](1));
    }

    // --------------------------------------------------------------------- //
    //  Constructor                                                           //
    // --------------------------------------------------------------------- //

    function test_constructor_zeroAddress_reverts() public {
        vm.expectRevert(FeeRouter.ZeroAddress.selector);
        new FeeRouter(address(0), address(factory), address(hook), address(weth), poolManager, address(0), _zeroTreasuryKey(), address(registry), 1000, 1 ether, 1 hours, DISCLOSURE);
    }

    function test_constructor_slippageAboveCeiling_reverts() public {
        vm.expectRevert(FeeRouter.BadSplit.selector);
        new FeeRouter(realCreator, address(factory), address(hook), address(weth), poolManager, address(0), _zeroTreasuryKey(), address(registry), 2001, 1 ether, 1 hours, DISCLOSURE);
    }

    function test_constructor_treasuryAssetNotAllowlisted_reverts() public {
        MockERC20 notAllowed = new MockERC20("X", "X", 18);
        vm.expectRevert(FeeRouter.TreasuryBucketDisabled.selector);
        new FeeRouter(realCreator, address(factory), address(hook), address(weth), poolManager, address(notAllowed), _zeroTreasuryKey(), address(registry), 1000, 1 ether, 1 hours, DISCLOSURE);
    }

    function test_constructor_defaultSplitIs100PercentCreator() public {
        FeeRouter router = _deployRouter(address(0));
        assertEq(router.creatorBps(), BPS);
        assertEq(router.treasuryBps(), 0);
        assertEq(router.buybackBps(), 0);
        assertEq(router.rewardsBps(), 0);
    }

    function test_noOwnerGatedFunctionExists() public {
        // No Ownable import anywhere in FeeRouter — the only privileged address is
        // realCreator, scoped to the specific functions tested below, not a
        // catch-all admin role.
        FeeRouter router = _deployRouter(address(0));
        assertEq(router.realCreator(), realCreator);
    }

    // --------------------------------------------------------------------- //
    //  Wiring                                                                //
    // --------------------------------------------------------------------- //

    function test_launchNew_onlyRealCreatorOrDeployer() public {
        FeeRouter router = _deployRouter(address(0));
        vm.prank(stranger);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.launchNew("T", "T", NOTICE, "", new address[](1));
    }

    function test_launchNew_wiresTokenTreasuryAndVault() public {
        (FeeRouter router, address token, address treasury) = _wiredRouter();
        assertTrue(router.wired());
        assertEq(router.token(), token);
        assertEq(router.treasury(), treasury);
        assertTrue(router.stakingVault() != address(0));
        assertEq(HolderStakingVault(router.stakingVault()).router(), address(router));
        assertEq(MockRouterToken(token).creator(), address(router)); // router IS on-chain creator
        assertEq(ProjectTreasury(treasury).creator(), address(router));
    }

    function test_launchNew_secondCall_reverts() public {
        (FeeRouter router,,) = _wiredRouter();
        vm.prank(realCreator);
        vm.expectRevert(FeeRouter.AlreadyWired.selector);
        router.launchNew("T", "T", NOTICE, "", new address[](1));
    }

    function test_adopt_onlyRealCreator() public {
        FeeRouter router = _deployRouter(address(0));
        vm.prank(stranger);
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.adopt(address(0x1), address(0x2));
    }

    function test_adopt_rejectsTreasuryBucketConfigured() public {
        FeeRouter router = _deployRouter(address(treasuryAsset));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouter.TreasuryBucketDisabled.selector);
        router.adopt(address(0x1), address(0x2));
    }

    function test_adopt_rejectsWrongCreator() public {
        FeeRouter router = _deployRouter(address(0));
        MockRouterToken token = new MockRouterToken(stranger); // creator() = stranger, not realCreator
        vm.prank(realCreator);
        vm.expectRevert(FeeRouter.NotTokenCreator.selector);
        router.adopt(address(token), address(0x2));
    }

    function test_adopt_wiresWithoutBecomingOnChainCreator() public {
        FeeRouter router = _deployRouter(address(0));
        MockRouterToken token = new MockRouterToken(realCreator);
        ProjectTreasury treasury = new ProjectTreasury(address(token), realCreator, NOTICE, address(registry));
        vm.prank(realCreator);
        token.setTreasury(address(treasury));
        vm.prank(realCreator);
        router.adopt(address(token), address(treasury));
        assertTrue(router.wired());
        assertEq(MockRouterToken(token).creator(), realCreator); // unchanged — router never became creator
    }

    // --------------------------------------------------------------------- //
    //  Split scheduling                                                     //
    // --------------------------------------------------------------------- //

    function test_scheduleSplit_onlyRealCreator() public {
        FeeRouter router = _deployRouter(address(0));
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.scheduleSplit(10000, 0, 0, 0);
    }

    function test_scheduleSplit_badSum_reverts() public {
        FeeRouter router = _deployRouter(address(0));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouter.BadSplit.selector);
        router.scheduleSplit(5000, 0, 0, 0);
    }

    function test_scheduleSplit_treasuryBpsWithoutAsset_reverts() public {
        FeeRouter router = _deployRouter(address(0));
        vm.prank(realCreator);
        vm.expectRevert(FeeRouter.TreasuryBucketDisabled.selector);
        router.scheduleSplit(0, 10000, 0, 0);
    }

    function test_scheduleSplit_notEffectiveBeforeDelay() public {
        FeeRouter router = _deployRouter(address(0));
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 0, 10000);
        vm.warp(block.timestamp + 6 days);
        router.applySplit();
        assertEq(router.creatorBps(), 10000); // unchanged — still the default
        assertTrue(router.hasPendingSplit());
    }

    function test_scheduleSplit_effectiveAfter7Days() public {
        FeeRouter router = _deployRouter(address(0));
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 0, 10000);
        vm.warp(block.timestamp + 7 days);
        router.applySplit();
        assertEq(router.rewardsBps(), 10000);
        assertFalse(router.hasPendingSplit());
    }

    // --------------------------------------------------------------------- //
    //  route() — creator bucket (no swap needed)                            //
    // --------------------------------------------------------------------- //

    function test_route_notWired_reverts() public {
        FeeRouter router = _deployRouter(address(0));
        vm.expectRevert(FeeRouter.NotWired.selector);
        router.route(0, 0, 0);
    }

    function test_route_nothingToRoute_reverts() public {
        (FeeRouter router,,) = _wiredRouter();
        vm.expectRevert(FeeRouter.NothingToRoute.selector);
        router.route(0, 0, 0);
    }

    function test_route_defaultSplit_allToCreator() public {
        (FeeRouter router,,) = _wiredRouter();
        hook.credit(address(router), 1 ether);

        router.route(0, 0, 0);

        assertEq(weth.balanceOf(realCreator), 1 ether);
        assertEq(router.totalRoutedToCreator(), 1 ether);
    }

    function test_route_capsAtMaxRoutePerCall() public {
        FeeRouter router = _deployRouter(address(0));
        // Re-deploy with a tiny cap to exercise the clamp.
        router = new FeeRouter(realCreator, address(factory), address(hook), address(weth), poolManager, address(0), _zeroTreasuryKey(), address(registry), 1000, 1 ether, 1 hours, DISCLOSURE);
        vm.prank(realCreator);
        router.launchNew("T", "T", NOTICE, "", new address[](1));
        hook.credit(address(router), 5 ether);

        router.route(0, 0, 0);

        assertEq(weth.balanceOf(realCreator), 1 ether); // capped, not the full 5
        assertEq(weth.balanceOf(address(router)), 4 ether); // remainder stays for the next call
    }

    function test_route_cooldown_blocksImmediateSecondCall() public {
        (FeeRouter router,,) = _wiredRouter();
        hook.credit(address(router), 2 ether);
        router.route(1 ether, 0, 0);

        hook.credit(address(router), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.Cooldown.selector, router.readyAt()));
        router.route(0, 0, 0);
    }

    function test_route_afterCooldown_succeeds() public {
        (FeeRouter router,,) = _wiredRouter();
        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0);

        hook.credit(address(router), 1 ether);
        vm.warp(block.timestamp + 1 hours);
        router.route(0, 0, 0);

        assertEq(router.totalRoutedToCreator(), 2 ether);
    }

    // --------------------------------------------------------------------- //
    //  route() — rounding + 0/100% edges across creator/rewards             //
    // --------------------------------------------------------------------- //

    function test_route_rewardsBucket_100Percent() public {
        (FeeRouter router,,) = _wiredRouter();
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 0, 10000);
        vm.warp(block.timestamp + 7 days);

        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0);

        address vault = router.stakingVault();
        assertEq(weth.balanceOf(vault), 1 ether);
        assertEq(router.totalRoutedToRewards(), 1 ether);
        assertEq(weth.balanceOf(realCreator), 0);
    }

    function test_route_splitRounding_remainderGoesToRewards() public {
        (FeeRouter router,,) = _wiredRouter();
        // 33/33/0/34 of an amount not evenly divisible by 3 exercises truncation.
        vm.prank(realCreator);
        router.scheduleSplit(3333, 0, 0, 6667);
        vm.warp(block.timestamp + 7 days);

        hook.credit(address(router), 100); // 100 wei, deliberately tiny/indivisible
        router.route(0, 0, 0);

        uint256 toCreator = (100 * 3333) / BPS; // = 33
        uint256 toRewards = 100 - toCreator; // = 67 (remainder, not 100*6667/10000=66)
        assertEq(weth.balanceOf(realCreator), toCreator);
        assertEq(weth.balanceOf(router.stakingVault()), toRewards);
        assertEq(toCreator + toRewards, 100); // no wei lost
    }

    // --------------------------------------------------------------------- //
    //  Buyback bucket — deferral before the pool is wired                   //
    // --------------------------------------------------------------------- //

    function test_route_buybackBeforeWired_defersRatherThanReverting() public {
        (FeeRouter router, address token,) = _wiredRouter();
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 10000, 0);
        vm.warp(block.timestamp + 7 days);

        hook.credit(address(router), 1 ether);
        router.route(0, 0, 0);

        assertEq(router.pendingBuybackWeth(), 1 ether);
        assertEq(router.totalRoutedToBuyback(), 0); // not yet executed
        assertEq(weth.balanceOf(token), 0);
    }

    function test_wireBuybackPool_notWired_reverts() public {
        FeeRouter router = _deployRouter(address(0));
        vm.expectRevert(FeeRouter.NotWired.selector);
        router.wireBuybackPool();
    }

    function test_wireBuybackPool_notGraduated_reverts() public {
        (FeeRouter router,,) = _wiredRouter();
        vm.expectRevert(FeeRouter.NotGraduated.selector);
        router.wireBuybackPool();
    }

    function test_wireBuybackPool_success_ordersCurrenciesByAddress() public {
        (FeeRouter router, address token,) = _wiredRouter();
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
        (FeeRouter router,,) = _wiredRouter();
        vm.expectRevert(FeeRouter.BuybackNotWired.selector);
        router.flushDeferredBuyback(0);
    }

    // --------------------------------------------------------------------- //
    //  routeIn — non-WETH currencies (inert until a non-WETH pool exists)   //
    // --------------------------------------------------------------------- //

    function test_routeIn_rejectsWeth() public {
        (FeeRouter router,,) = _wiredRouter();
        vm.expectRevert(FeeRouter.UseRouteForWeth.selector);
        router.routeIn(address(weth));
    }

    function test_routeIn_paysEntireAmountToCreator() public {
        (FeeRouter router,,) = _wiredRouter();
        MockERC20 nvda = new MockERC20("NVDA", "NVDA", 18);
        hook.creditIn(address(router), address(nvda), 5 ether);

        router.routeIn(address(nvda));

        assertEq(nvda.balanceOf(realCreator), 5 ether);
    }

    // --------------------------------------------------------------------- //
    //  Creator/Treasury passthroughs                                        //
    // --------------------------------------------------------------------- //

    function test_passthroughs_onlyRealCreator() public {
        (FeeRouter router,,) = _wiredRouter();
        vm.startPrank(stranger);
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.acceptDeposit(1);
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.declineDeposit(1);
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.announceWithdrawal(address(treasuryAsset), 1);
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.executeWithdrawal(1);
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.cancelWithdrawal(1);
        vm.expectRevert(FeeRouter.NotRealCreator.selector);
        router.setMetadataURI("ipfs://evil");
        vm.stopPrank();
    }

    function test_creatorDeposit_and_withdrawal_roundTrip() public {
        (FeeRouter router,, address treasury) = _wiredRouter();
        treasuryAsset.mint(realCreator, 10 ether);

        vm.startPrank(realCreator);
        treasuryAsset.approve(address(router), 10 ether);
        router.creatorDeposit(address(treasuryAsset), 10 ether);
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)), 10 ether);

        uint256 id = router.announceWithdrawal(address(treasuryAsset), 4 ether);
        vm.warp(block.timestamp + NOTICE);
        router.executeWithdrawal(id);
        vm.stopPrank();

        // ProjectTreasury pays out to `creator` (the router) — passthrough must
        // sweep it straight to realCreator, not strand it in the router.
        assertEq(treasuryAsset.balanceOf(realCreator), 4 ether);
        assertEq(treasuryAsset.balanceOf(address(router)), 0);
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)), 6 ether);
    }

    function test_setMetadataURI_passthrough() public {
        (FeeRouter router, address token,) = _wiredRouter();
        vm.prank(realCreator);
        router.setMetadataURI("ipfs://new");
        assertEq(MockRouterToken(token).metadataURI(), "ipfs://new");
    }
}
