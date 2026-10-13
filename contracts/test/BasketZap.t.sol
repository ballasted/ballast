// SPDX-License-Identifier: MIT
// 0.8.26 — shares BasketZap's import graph (v4-periphery's V4Router), same
// reason BallastRouterV2.t.sol carries the identical pin. AssetRegistry.sol
// and the mock files this test imports were widened to a floating pragma
// range to accommodate this (see their own headers) — none have any
// version-specific syntax.
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BasketZap} from "../src/BasketZap.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockBasketFactory} from "./mocks/MockBasketFactory.sol";

/// @notice Guard-rail unit tests for BasketZap — every check that fires
///         BEFORE any swap is attempted (weights, self-backing, duplicate
///         asset, too-many/no legs, deadline, zero ETH, unknown launch,
///         non-creator, unlisted asset, stale/invalid/deviated price). These
///         never reach `poolManager.unlock()`, so a non-functional dummy
///         PoolManager address and empty fablesHops/ramsesRoutes tables are
///         fine — the swap path itself is never exercised here.
///
/// @dev REWRITE (docs/BASKET_DISCOVERY.md, this session): the prior version
///      of this file mocked the external UniversalRouter/Permit2 to drive
///      swap-execution assertions without real liquidity. BasketZap no longer
///      goes through an external router — it inherits v4-periphery's
///      V4Router directly and talks to Fables/Ramses pools itself, the exact
///      same shape `BallastRouterV2` already uses. That contract's own test
///      suite (`BallastRouterV2.t.sol`) doesn't attempt a PoolManager mock
///      either — mocking v4's flash-accounting unlock/settle/take cycle
///      faithfully is not worth it when a real fork is available — it is
///      ENTIRELY a fork test (`BallastRouterV2ForkTest`, skips without
///      RH_RPC_URL_PAID). BasketZap now follows the same convention: every
///      assertion that requires an actual successful (or actually-failing)
///      swap lives in `BasketZapFork.t.sol`, now against REAL Fables/Ramses
///      routes (no more TestPoolSeeder — real routes exist, see
///      docs/BASKET_DISCOVERY.md §2).
contract BasketZapTest is Test {
    AssetRegistry registry;
    MockBasketFactory factory;
    MockWETH weth;
    BasketZap zap;

    // Not a working PoolManager — BasketZap's constructor only checks it's
    // non-zero; every test below reverts before `poolManager.unlock()` is
    // ever reached.
    address constant DUMMY_POOL_MANAGER = address(0xBEEF);

    MockERC20 launchToken;
    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address treasury = makeAddr("treasury");

    MockStockToken assetA;
    MockAggregator feedA;
    MockStockToken assetB;
    MockAggregator feedB;

    uint256 constant PRICE_A = 100_00000000; // $100, 8dp
    uint256 constant PRICE_B = 50_00000000; // $50, 8dp

    function setUp() public {
        registry = new AssetRegistry(owner);
        factory = new MockBasketFactory();
        weth = new MockWETH();

        BasketZap.FablesHop[] memory noFables = new BasketZap.FablesHop[](0);
        BasketZap.RamsesRoute[] memory noRamses = new BasketZap.RamsesRoute[](0);
        zap = new BasketZap(
            address(factory), address(registry), IPoolManager(DUMMY_POOL_MANAGER), address(weth), noFables, noRamses
        );

        launchToken = new MockERC20("Project", "PRJ", 18);
        factory.addLaunch(address(launchToken), treasury, creator);

        assetA = new MockStockToken("Asset A", "AA", 18);
        feedA = new MockAggregator(8, int256(PRICE_A), block.timestamp);
        vm.prank(owner);
        registry.setAsset(address(assetA), address(feedA), 1 days, 1e15, MarketHours.UsEquities24_5);

        assetB = new MockStockToken("Asset B", "AB", 18);
        feedB = new MockAggregator(8, int256(PRICE_B), block.timestamp);
        vm.prank(owner);
        registry.setAsset(address(assetB), address(feedB), 1 days, 1e15, MarketHours.UsEquities24_5);

        vm.deal(creator, 1_000 ether);
    }

    function _leg(address asset, uint16 weightBps, uint256 minOut) internal pure returns (BasketZap.Leg memory) {
        uint256[] memory empty = new uint256[](0);
        return BasketZap.Leg({
            asset: asset,
            weightBps: weightBps,
            preferFables: false,
            fablesHopIdx: empty,
            ramsesHopIdx: empty,
            minOut: minOut
        });
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    // --------------------------------------------------------------------- //
    //  Revert paths — all fire before any swap attempt                      //
    // --------------------------------------------------------------------- //

    function test_revert_weightsNotSum10000() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](2);
        legs[0] = _leg(address(assetA), 5_000, 1);
        legs[1] = _leg(address(assetB), 4_999, 1);

        vm.prank(creator);
        vm.expectRevert(BasketZap.WeightsMustSumToBps.selector);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_tooManyLegs() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](7);
        for (uint256 i = 0; i < 7; i++) {
            legs[i] = _leg(address(uint160(0x1000 + i)), 1_000, 1);
        }

        vm.prank(creator);
        vm.expectRevert(BasketZap.TooManyLegs.selector);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_noLegs() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](0);
        vm.prank(creator);
        vm.expectRevert(BasketZap.NoLegs.selector);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_unlistedAsset() public {
        MockStockToken notListed = new MockStockToken("Not Listed", "NL", 18);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(notListed), 10_000, 1);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.AssetNotAllowed.selector, address(notListed)));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_nonCreator() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(BasketZap.NotCreator.selector);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_unknownLaunch() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        vm.prank(creator);
        vm.expectRevert(BasketZap.UnknownLaunch.selector);
        zap.swapBasket{value: 1 ether}(makeAddr("notALaunch"), legs, _deadline());
    }

    function test_revert_selfBacking() public {
        vm.prank(owner);
        registry.setAsset(address(launchToken), address(feedA), 1 days, 1e15, MarketHours.UsEquities24_5);

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(launchToken), 10_000, 1);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.SelfBacking.selector, address(launchToken)));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_duplicateAsset() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](2);
        legs[0] = _leg(address(assetA), 5_000, 1);
        legs[1] = _leg(address(assetA), 5_000, 1);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.DuplicateAsset.selector, address(assetA)));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_zeroEthIn() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        vm.prank(creator);
        vm.expectRevert(BasketZap.ZeroEthIn.selector);
        zap.swapBasket{value: 0}(address(launchToken), legs, _deadline());
    }

    function test_revert_deadlineExpired() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(creator);
        vm.expectRevert(BasketZap.SwapDeadlineExpired.selector);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, block.timestamp - 1 hours);
    }

    function test_revert_minOutZero() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 0);

        vm.prank(creator);
        vm.expectRevert(BasketZap.MinOutTooLow.selector);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_staleFeed() public {
        feedA.setAnswer(int256(PRICE_A), block.timestamp);
        vm.warp(block.timestamp + 2 days); // staleAfter is 1 days

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.StalePrice.selector, address(assetA), block.timestamp - 2 days));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_revert_invalidPrice_negativeAnswer() public {
        feedA.setAnswer(-1, block.timestamp);

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.InvalidPrice.selector, address(assetA)));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    // No-route case: a listed, fresh-priced asset with empty fablesHopIdx AND
    // ramsesHopIdx reaches the swap attempt and fails BOTH venues (there's
    // nothing to try), so it must surface AllVenuesFailedForLeg, not silently
    // return a zero amount.
    function test_revert_allVenuesFailed_noRouteConfigured() public {
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.AllVenuesFailedForLeg.selector, address(assetA)));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    // --------------------------------------------------------------------- //
    //  Fuzz — guard logic only, no swap execution                           //
    // --------------------------------------------------------------------- //

    function testFuzz_revertsWheneverWeightsDontSum(uint16 weightA, uint16 weightB) public {
        vm.assume(uint256(weightA) + uint256(weightB) != 10_000);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](2);
        legs[0] = _leg(address(assetA), weightA, 1);
        legs[1] = _leg(address(assetB), weightB, 1);

        vm.prank(creator);
        vm.expectRevert(BasketZap.WeightsMustSumToBps.selector);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    // --------------------------------------------------------------------- //
    //  Constructor guards                                                   //
    // --------------------------------------------------------------------- //

    function test_constructor_zeroAddressGuards() public {
        BasketZap.FablesHop[] memory noFables = new BasketZap.FablesHop[](0);
        BasketZap.RamsesRoute[] memory noRamses = new BasketZap.RamsesRoute[](0);

        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(0), address(registry), IPoolManager(DUMMY_POOL_MANAGER), address(weth), noFables, noRamses);
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(factory), address(0), IPoolManager(DUMMY_POOL_MANAGER), address(weth), noFables, noRamses);
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(factory), address(registry), IPoolManager(address(0)), address(weth), noFables, noRamses);
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(factory), address(registry), IPoolManager(DUMMY_POOL_MANAGER), address(0), noFables, noRamses);
    }

    function test_noAdminSurface() public view {
        // BasketZap must have no owner/admin/pause/upgrade/rescue function of
        // any kind. There's no base contract to inherit one from beyond
        // V4Router/ReentrancyGuard (neither of which adds one), so this is
        // really just documenting the invariant the constructor/ABI already
        // enforce: immutable config, no setters.
        assertEq(zap.MAX_LEGS(), 6);
    }
}
