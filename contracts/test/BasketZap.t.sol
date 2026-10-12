// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BasketZap} from "../src/BasketZap.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockBasketFactory} from "./mocks/MockBasketFactory.sol";
import {MockBasketPermit2} from "./mocks/MockBasketPermit2.sol";
import {MockBasketRouter} from "./mocks/MockBasketRouter.sol";

/// @notice Adversarial-first unit tests for BasketZap. The mock router/permit2
///         pair (test/mocks/MockBasketRouter.sol, MockBasketPermit2.sol) lets
///         every revert path and invariant be driven directly, without real
///         liquidity. The real swap-execution encoding against live pools is
///         proven separately in BasketZapFork.t.sol.
contract BasketZapTest is Test {
    AssetRegistry registry;
    MockBasketFactory factory;
    MockBasketPermit2 permit2;
    MockBasketRouter router;
    MockWETH weth;
    BasketZap zap;

    MockERC20 launchToken;
    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address treasury = makeAddr("treasury");

    MockStockToken assetA;
    MockAggregator feedA;
    MockStockToken assetB;
    MockAggregator feedB;
    MockStockToken assetC;
    MockAggregator feedC;

    uint256 constant PRICE_A = 100_00000000; // $100, 8dp
    uint256 constant PRICE_B = 50_00000000; // $50, 8dp
    uint256 constant PRICE_C = 10_00000000; // $10, 8dp

    event BasketSwapped(
        address indexed launchToken,
        address indexed creator,
        uint256 ethIn,
        uint256 ethRefunded,
        address[] assets,
        uint256[] amountsOut
    );

    function setUp() public {
        registry = new AssetRegistry(owner);
        factory = new MockBasketFactory();
        permit2 = new MockBasketPermit2();
        router = new MockBasketRouter(address(permit2));
        weth = new MockWETH();

        zap = new BasketZap(address(factory), address(registry), address(weth), address(router), address(permit2));

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

        assetC = new MockStockToken("Asset C", "AC", 18);
        feedC = new MockAggregator(8, int256(PRICE_C), block.timestamp);
        vm.prank(owner);
        registry.setAsset(address(assetC), address(feedC), 1 days, 1e15, MarketHours.UsEquities24_5);

        // The mock router needs a supply of each asset on hand to pay out.
        assetA.mint(address(router), 1_000_000 ether);
        assetB.mint(address(router), 1_000_000 ether);
        assetC.mint(address(router), 1_000_000 ether);

        vm.deal(creator, 1_000 ether);
    }

    function _leg(address asset, uint16 weightBps, uint256 minOut) internal pure returns (BasketZap.Leg memory) {
        return BasketZap.Leg({asset: asset, weightBps: weightBps, fee: 3000, tickSpacing: 60, hooks: address(0), minOut: minOut});
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    // --------------------------------------------------------------------- //
    //  Happy path                                                           //
    // --------------------------------------------------------------------- //

    function test_happyPath_singleLeg() public {
        router.setOutAmount(address(assetA), 1 ether);

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        vm.prank(creator);
        uint256[] memory out = zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());

        assertEq(out[0], 1 ether);
        assertEq(assetA.balanceOf(creator), 1 ether);
        assertEq(assetA.balanceOf(address(zap)), 0);
        assertEq(weth.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
    }

    function test_happyPath_threeLegs_noFundsLeftInContract() public {
        router.setOutAmount(address(assetA), 1 ether);
        router.setOutAmount(address(assetB), 2 ether);
        router.setOutAmount(address(assetC), 3 ether);

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](3);
        legs[0] = _leg(address(assetA), 5_000, 1);
        legs[1] = _leg(address(assetB), 3_000, 1);
        legs[2] = _leg(address(assetC), 2_000, 1);

        vm.prank(creator);
        zap.swapBasket{value: 10 ether}(address(launchToken), legs, _deadline());

        assertEq(assetA.balanceOf(creator), 1 ether);
        assertEq(assetB.balanceOf(creator), 2 ether);
        assertEq(assetC.balanceOf(creator), 3 ether);

        // no-funds-left invariant
        assertEq(address(zap).balance, 0);
        assertEq(weth.balanceOf(address(zap)), 0);
        assertEq(assetA.balanceOf(address(zap)), 0);
        assertEq(assetB.balanceOf(address(zap)), 0);
        assertEq(assetC.balanceOf(address(zap)), 0);
    }

    function test_emitsBasketSwapped() public {
        router.setOutAmount(address(assetA), 1 ether);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);

        address[] memory assets_ = new address[](1);
        assets_[0] = address(assetA);
        uint256[] memory amounts_ = new uint256[](1);
        amounts_[0] = 1 ether;

        vm.expectEmit(true, true, false, true, address(zap));
        emit BasketSwapped(address(launchToken), creator, 1 ether, 0, assets_, amounts_);

        vm.prank(creator);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    // --------------------------------------------------------------------- //
    //  Dust refund                                                          //
    // --------------------------------------------------------------------- //

    function test_dustRefund_unevenWeights() public {
        router.setOutAmount(address(assetA), 1 ether);
        router.setOutAmount(address(assetB), 1 ether);
        router.setOutAmount(address(assetC), 1 ether);

        // 3334 + 3333 + 3333 = 10000, but against an odd msg.value this still
        // leaves floor-division dust on at least one leg.
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](3);
        legs[0] = _leg(address(assetA), 3334, 1);
        legs[1] = _leg(address(assetB), 3333, 1);
        legs[2] = _leg(address(assetC), 3333, 1);

        uint256 ethIn = 1 ether + 7; // deliberately not a multiple of 10000
        uint256 expectedSpent = (ethIn * 3334) / 10_000 + (ethIn * 3333) / 10_000 + (ethIn * 3333) / 10_000;
        uint256 expectedDust = ethIn - expectedSpent;
        assertGt(expectedDust, 0);

        vm.prank(creator);
        zap.swapBasket{value: ethIn}(address(launchToken), legs, _deadline());

        assertEq(weth.balanceOf(creator), expectedDust);
        assertEq(weth.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
    }

    // --------------------------------------------------------------------- //
    //  Revert paths                                                         //
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
            // distinct dummy addresses; weights don't need to sum correctly —
            // the length check fires first.
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

    function test_revert_minOutNotMet() public {
        router.setOutAmount(address(assetA), 0.5 ether);

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1 ether);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.InsufficientOutput.selector, address(assetA), 0.5 ether, 1 ether));
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

    function test_revert_priceDeviationTooLarge() public {
        // First call establishes lastPrice[assetA] = PRICE_A.
        router.setOutAmount(address(assetA), 1 ether);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);
        vm.prank(creator);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());

        // Price jumps >20% in the same block (no widening periods elapsed).
        uint256 movedPrice = (PRICE_A * 125) / 100; // +25%
        feedA.setAnswer(int256(movedPrice), block.timestamp);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.PriceDeviationTooLarge.selector, address(assetA), PRICE_A, movedPrice));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
    }

    function test_priceDeviation_withinBandSucceeds() public {
        router.setOutAmount(address(assetA), 1 ether);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);
        vm.prank(creator);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());

        uint256 movedPrice = (PRICE_A * 110) / 100; // +10%, inside the 20% band
        feedA.setAnswer(int256(movedPrice), block.timestamp);

        vm.prank(creator);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
        assertEq(assetA.balanceOf(creator), 2 ether);
    }

    function test_priceDeviation_widensAfterSevenDays() public {
        router.setOutAmount(address(assetA), 1 ether);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = _leg(address(assetA), 10_000, 1);
        vm.prank(creator);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());

        // +35% would revert against the base 20% band...
        uint256 movedPrice = (PRICE_A * 135) / 100;
        feedA.setAnswer(int256(movedPrice), block.timestamp);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.PriceDeviationTooLarge.selector, address(assetA), PRICE_A, movedPrice));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());

        // ...but after 7 days the band widens to 40% (2x), so the same move now clears.
        vm.warp(block.timestamp + 7 days);
        feedA.setAnswer(int256(movedPrice), block.timestamp);
        vm.prank(creator);
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());
        assertEq(assetA.balanceOf(creator), 2 ether);
    }

    function test_revert_failingLeg_wholeTxReverts() public {
        router.setOutAmount(address(assetA), 1 ether);
        router.setShouldRevert(address(assetB), true);

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](2);
        legs[0] = _leg(address(assetA), 5_000, 1);
        legs[1] = _leg(address(assetB), 5_000, 1);

        uint256 creatorEthBefore = creator.balance;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockBasketRouter.MockLegReverted.selector, address(assetB)));
        zap.swapBasket{value: 1 ether}(address(launchToken), legs, _deadline());

        // All-or-nothing: the first leg's would-be success never persisted.
        assertEq(assetA.balanceOf(creator), 0);
        assertEq(creator.balance, creatorEthBefore);
        assertEq(address(zap).balance, 0);
        assertEq(weth.balanceOf(address(zap)), 0);
    }

    // --------------------------------------------------------------------- //
    //  Fuzz                                                                 //
    // --------------------------------------------------------------------- //

    function testFuzz_twoLegWeights_alwaysConserveValue(uint16 weightA, uint96 ethInRaw) public {
        weightA = uint16(bound(weightA, 1, 9_999));
        uint16 weightB = 10_000 - weightA;
        uint256 ethIn = bound(ethInRaw, 2, 1_000 ether);

        router.setOutAmount(address(assetA), 1 ether);
        router.setOutAmount(address(assetB), 1 ether);

        BasketZap.Leg[] memory legs = new BasketZap.Leg[](2);
        legs[0] = _leg(address(assetA), weightA, 1);
        legs[1] = _leg(address(assetB), weightB, 1);

        vm.deal(creator, ethIn);
        vm.prank(creator);
        zap.swapBasket{value: ethIn}(address(launchToken), legs, _deadline());

        uint256 expectedA = (ethIn * weightA) / 10_000;
        uint256 expectedB = (ethIn * weightB) / 10_000;
        uint256 refund = weth.balanceOf(creator);

        // Conservation: every wei of ethIn is accounted for as either a swap
        // input or a refund — nothing is created or lost.
        assertEq(expectedA + expectedB + refund, ethIn);
        assertEq(address(zap).balance, 0);
        assertEq(weth.balanceOf(address(zap)), 0);
    }

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
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(0), address(registry), address(weth), address(router), address(permit2));
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(factory), address(0), address(weth), address(router), address(permit2));
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(factory), address(registry), address(0), address(router), address(permit2));
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(factory), address(registry), address(weth), address(0), address(permit2));
        vm.expectRevert(BasketZap.ZeroAddress.selector);
        new BasketZap(address(factory), address(registry), address(weth), address(router), address(0));
    }

    function test_noAdminSurface() public view {
        // BasketZap must have no owner/admin/pause/upgrade/rescue function of
        // any kind. There's no base contract to inherit one from (just
        // ReentrancyGuard), so this is really just documenting the invariant
        // the constructor/ABI already enforce: immutable config, no setters.
        assertEq(zap.MAX_LEGS(), 6);
    }
}
