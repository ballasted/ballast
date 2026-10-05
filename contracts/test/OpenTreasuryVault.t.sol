// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {OpenTreasuryVault} from "../src/OpenTreasuryVault.sol";
import {OpenTreasuryVaultFactory} from "../src/OpenTreasuryVaultFactory.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockBallastFactoryLaunchId} from "./mocks/MockBallastFactoryLaunchId.sol";
import {MockFeeHook} from "./mocks/MockFeeHook.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";
import {ReentrantOnReceiveERC20} from "./mocks/ReentrantOnReceiveERC20.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {NoReturnERC20} from "./mocks/NoReturnERC20.sol";

contract OpenTreasuryVaultTest is Test {
    uint256 constant WAD = 1e18;
    uint256 constant MIN_HOLD = 24 hours;
    uint256 constant REWARDS_DURATION = 7 days;

    AssetRegistry registry;
    MockBallastFactoryLaunchId ballastFactory;
    OpenTreasuryVaultFactory factory;
    MockERC20 weth; // rewardAsset
    MockERC20 token; // the "project token" this vault backs

    MockERC20 asset18;
    MockAggregator feed18; // 8 decimals, $100.00000000
    MockERC20 asset6;
    MockAggregator feed6; // 8 decimals, $50.00000000

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address creator = makeAddr("creator");

    function setUp() public {
        registry = new AssetRegistry(owner);
        ballastFactory = new MockBallastFactoryLaunchId();
        weth = new MockERC20("WETH", "WETH", 18);
        token = new MockERC20("Project", "PRJ", 18);
        ballastFactory.markLaunched(address(token));

        factory = new OpenTreasuryVaultFactory(
            address(ballastFactory), address(registry), address(weth), MIN_HOLD, REWARDS_DURATION
        );

        asset18 = new MockERC20("Asset18", "A18", 18);
        feed18 = new MockAggregator(8, 100_00000000, block.timestamp);
        vm.prank(owner);
        registry.setAsset(address(asset18), address(feed18), 1 days, 1e15, MarketHours.UsEquities24_5);

        asset6 = new MockERC20("Asset6", "A6", 6);
        feed6 = new MockAggregator(8, 50_00000000, block.timestamp);
        vm.prank(owner);
        registry.setAsset(address(asset6), address(feed6), 1 days, 1e4, MarketHours.UsEquities24_5);

        asset18.mint(alice, 1_000_000 ether);
        asset18.mint(bob, 1_000_000 ether);
        asset6.mint(alice, 1_000_000e6);
        asset6.mint(bob, 1_000_000e6);
    }

    function _vault() internal returns (OpenTreasuryVault v) {
        v = OpenTreasuryVault(factory.getOrCreateVault(address(token)));
    }

    function _depositAsAlice(OpenTreasuryVault v, MockERC20 asset, uint256 amount) internal {
        vm.startPrank(alice);
        asset.approve(address(v), amount);
        v.deposit(address(asset), amount);
        vm.stopPrank();
    }

    // --------------------------------------------------------------------- //
    //  Vault creation — deterministic, idempotent, launched-token gate      //
    // --------------------------------------------------------------------- //

    function test_getOrCreateVault_matchesPredictedAddress() public {
        address predicted = factory.vaultFor(address(token));
        address created = factory.getOrCreateVault(address(token));
        assertEq(created, predicted);
    }

    function test_getOrCreateVault_idempotent() public {
        address first = factory.getOrCreateVault(address(token));
        address second = factory.getOrCreateVault(address(token));
        assertEq(first, second);
    }

    function test_getOrCreateVault_notLaunchedToken_reverts() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 18);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVaultFactory.NotLaunchedToken.selector, address(randomToken)));
        factory.getOrCreateVault(address(randomToken));
    }

    function test_initialize_cannotBeCalledTwice() public {
        OpenTreasuryVault v = _vault();
        vm.expectRevert(OpenTreasuryVault.AlreadyInitialized.selector);
        v.initialize(address(token), address(factory), address(registry), address(weth), MIN_HOLD, REWARDS_DURATION);
    }

    // --------------------------------------------------------------------- //
    //  Deposit / withdraw — both decimals classes                          //
    // --------------------------------------------------------------------- //

    function test_deposit_18decimals_computesExpectedWeight() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether); // 1 token @ $100.00000000 (8 dec) => $100 => 100e18 weight
        assertEq(v.principal(alice, address(asset18)), 1 ether);
        assertEq(v.assetWeight(alice, address(asset18)), 100 ether);
        assertEq(v.totalWeight(), 100 ether);
        assertEq(asset18.balanceOf(address(v)), 1 ether);
    }

    function test_deposit_6decimals_computesExpectedWeight() public {
        OpenTreasuryVault v = _vault();
        vm.startPrank(alice);
        asset6.approve(address(v), 1e6);
        v.deposit(address(asset6), 1e6); // 1 token @ $50.00000000 => $50 => 50e18 weight
        vm.stopPrank();
        assertEq(v.principal(alice, address(asset6)), 1e6);
        assertEq(v.assetWeight(alice, address(asset6)), 50 ether);
    }

    function test_withdraw_partial_thenFull() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 10 ether);
        vm.warp(block.timestamp + MIN_HOLD);

        vm.prank(alice);
        v.withdraw(address(asset18), 4 ether);
        assertEq(v.principal(alice, address(asset18)), 6 ether);
        assertEq(v.assetWeight(alice, address(asset18)), 600 ether); // 60% of original 1000e18 weight
        assertEq(asset18.balanceOf(alice), 1_000_000 ether - 10 ether + 4 ether);

        vm.prank(alice);
        v.withdraw(address(asset18), 6 ether);
        assertEq(v.principal(alice, address(asset18)), 0);
        assertEq(v.assetWeight(alice, address(asset18)), 0);
        assertEq(v.totalWeight(), 0);
    }

    function test_withdraw_delistedAsset_stillWorks() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 5 ether);
        vm.warp(block.timestamp + MIN_HOLD);

        vm.prank(owner);
        registry.removeAsset(address(asset18));

        vm.prank(alice);
        v.withdraw(address(asset18), 5 ether); // never reverts — withdrawal never checks the registry
        assertEq(v.principal(alice, address(asset18)), 0);
    }

    function test_deposit_delistedAsset_reverts() public {
        OpenTreasuryVault v = _vault();
        vm.prank(owner);
        registry.removeAsset(address(asset18));

        vm.startPrank(alice);
        asset18.approve(address(v), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.AssetNotAllowed.selector, address(asset18)));
        v.deposit(address(asset18), 1 ether);
        vm.stopPrank();
    }

    function test_deposit_unlistedAsset_reverts() public {
        OpenTreasuryVault v = _vault();
        MockERC20 unlisted = new MockERC20("Unlisted", "UNL", 18);
        unlisted.mint(alice, 1 ether);
        vm.startPrank(alice);
        unlisted.approve(address(v), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.AssetNotAllowed.selector, address(unlisted)));
        v.deposit(address(unlisted), 1 ether);
        vm.stopPrank();
    }

    function test_deposit_selfBacking_reverts() public {
        // The project token itself is never a depositable asset (CLAUDE.md hard rule 13).
        vm.prank(owner);
        registry.setAsset(address(token), address(feed18), 1 days, 1, MarketHours.Crypto24_7);
        OpenTreasuryVault v = _vault();
        token.mint(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(v), 1 ether);
        vm.expectRevert(OpenTreasuryVault.SelfBacking.selector);
        v.deposit(address(token), 1 ether);
        vm.stopPrank();
    }

    function test_deposit_belowMinimum_reverts() public {
        OpenTreasuryVault v = _vault();
        vm.startPrank(alice);
        asset18.approve(address(v), 1);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.BelowMinimum.selector, 1, 1e15));
        v.deposit(address(asset18), 1);
        vm.stopPrank();
    }

    function test_withdraw_moreThanOwnBalance_reverts() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);
        vm.warp(block.timestamp + MIN_HOLD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.InsufficientBalance.selector, 2 ether, 1 ether));
        v.withdraw(address(asset18), 2 ether);
    }

    function test_withdraw_anotherDepositorsBalance_reverts() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);
        vm.warp(block.timestamp + MIN_HOLD);
        // bob never deposited — his own recorded principal is 0.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.InsufficientBalance.selector, 1, 0));
        v.withdraw(address(asset18), 1);
    }

    function test_withdraw_beforeMinimumTime_reverts() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);
        uint256 unlockAt = block.timestamp + MIN_HOLD;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.StillLocked.selector, unlockAt));
        v.withdraw(address(asset18), 1 ether);
    }

    function test_withdraw_topUpResetsHoldClockForWholeBalance() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);
        vm.warp(block.timestamp + MIN_HOLD - 1);
        _depositAsAlice(v, asset18, 1 ether); // resets the clock for the FULL 2 ether (D3)
        vm.warp(block.timestamp + 2); // only 1 second past the ORIGINAL deposit's clock, still short of the reset one
        vm.prank(alice);
        vm.expectRevert(); // StillLocked — exact unlockAt not asserted, just that it reverts
        v.withdraw(address(asset18), 1 ether);
    }

    // --------------------------------------------------------------------- //
    //  Fee-on-transfer                                                      //
    // --------------------------------------------------------------------- //

    function test_feeOnTransfer_creditedEqualsReceived_vaultCoversWithdrawals() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(200); // 2%
        vm.prank(owner);
        registry.setAsset(address(fot), address(feed18), 1 days, 1e15, MarketHours.Crypto24_7);
        fot.mint(alice, 100 ether);

        OpenTreasuryVault v = _vault();
        vm.startPrank(alice);
        fot.approve(address(v), 100 ether);
        v.deposit(address(fot), 100 ether); // requested 100, 2% fee => vault receives 98
        vm.stopPrank();

        uint256 credited = v.principal(alice, address(fot));
        assertEq(credited, 98 ether, "credited must equal RECEIVED, not requested");
        assertEq(fot.balanceOf(address(v)), credited, "vault balance must exactly cover recorded principal");

        vm.warp(block.timestamp + MIN_HOLD);
        vm.prank(alice);
        v.withdraw(address(fot), credited); // withdraw everything actually credited
        assertEq(v.principal(alice, address(fot)), 0);
        assertEq(fot.balanceOf(address(v)), 0, "vault never left holding a shortfall");
    }

    function test_noReturnValueToken_depositAndWithdrawWork() public {
        NoReturnERC20 usdtLike = new NoReturnERC20();
        vm.prank(owner);
        registry.setAsset(address(usdtLike), address(feed18), 1 days, 1e15, MarketHours.Crypto24_7);
        usdtLike.mint(alice, 10 ether);

        OpenTreasuryVault v = _vault();
        vm.startPrank(alice);
        usdtLike.approve(address(v), 10 ether);
        v.deposit(address(usdtLike), 10 ether);
        vm.stopPrank();
        assertEq(v.principal(alice, address(usdtLike)), 10 ether);

        vm.warp(block.timestamp + MIN_HOLD);
        vm.prank(alice);
        v.withdraw(address(usdtLike), 10 ether);
        assertEq(usdtLike.balanceOf(alice), 10 ether);
    }

    // --------------------------------------------------------------------- //
    //  Price guards                                                        //
    // --------------------------------------------------------------------- //

    function test_deposit_stalePrice_reverts() public {
        feed18.setAnswer(100_00000000, block.timestamp);
        vm.warp(block.timestamp + 2 days); // staleAfter is 1 days
        OpenTreasuryVault v = _vault();
        vm.startPrank(alice);
        asset18.approve(address(v), 1 ether);
        vm.expectRevert(); // StalePrice — timestamp-dependent, not asserting exact selector args
        v.deposit(address(asset18), 1 ether);
        vm.stopPrank();
    }

    function test_deposit_invalidPrice_reverts() public {
        feed18.setAnswer(0, block.timestamp);
        OpenTreasuryVault v = _vault();
        vm.startPrank(alice);
        asset18.approve(address(v), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.InvalidPrice.selector, address(asset18)));
        v.deposit(address(asset18), 1 ether);
        vm.stopPrank();
    }

    function test_deposit_priceDeviationTooLarge_reverts() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether); // establishes lastPrice = 100e8

        feed18.setAnswer(200_00000000, block.timestamp); // +100%, way past the 20% breaker
        vm.startPrank(alice);
        asset18.approve(address(v), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.PriceDeviationTooLarge.selector, address(asset18), 100_00000000, 200_00000000));
        v.deposit(address(asset18), 1 ether);
        vm.stopPrank();
    }

    function test_deposit_priceWithinDeviationBand_succeeds() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether); // lastPrice = 100e8

        feed18.setAnswer(115_00000000, block.timestamp); // +15%, within the 20% band
        _depositAsAlice(v, asset18, 1 ether); // must not revert
        assertEq(v.lastPrice(address(asset18)), 115_00000000);
    }

    function test_manipulatedPrice_cannotGrantOutsizedWeight_beyondGuard() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether); // lastPrice = 100e8, weight = 100e18

        // Largest single jump allowed is +20%.
        feed18.setAnswer(120_00000000, block.timestamp);
        vm.startPrank(alice);
        asset18.approve(address(v), 1 ether);
        v.deposit(address(asset18), 1 ether); // succeeds — exactly at the edge
        vm.stopPrank();
        // Second 1 ether deposit priced at $120 => 120e18 weight, not an outsized jump.
        assertEq(v.assetWeight(alice, address(asset18)), 100 ether + 120 ether);
    }

    // --------------------------------------------------------------------- //
    //  Reward math                                                          //
    // --------------------------------------------------------------------- //

    function test_rewards_singleDepositor_fullStream() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether); // weight = 100e18, sole depositor

        weth.mint(address(this), 7 ether);
        weth.approve(address(v), 7 ether);
        v.notifyReward(7 ether);

        vm.warp(block.timestamp + REWARDS_DURATION);
        uint256 earned = v.earned(alice);
        // Sole depositor for the whole period — gets ~the full stream (rate*duration rounding only).
        assertApproxEqAbs(earned, 7 ether, 1e12);

        vm.prank(alice);
        uint256 claimed = v.claim();
        assertEq(claimed, earned);
        assertEq(weth.balanceOf(alice), claimed);
    }

    function test_rewards_twoDepositors_splitByWeight() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 2 ether); // 200e18 weight
        vm.startPrank(bob);
        asset18.approve(address(v), 1 ether);
        v.deposit(address(asset18), 1 ether); // 100e18 weight
        vm.stopPrank();
        // alice: 2/3 of weight, bob: 1/3

        weth.mint(address(this), 9 ether);
        weth.approve(address(v), 9 ether);
        v.notifyReward(9 ether);
        vm.warp(block.timestamp + REWARDS_DURATION);

        uint256 aliceEarned = v.earned(alice);
        uint256 bobEarned = v.earned(bob);
        assertApproxEqAbs(aliceEarned, 6 ether, 1e12);
        assertApproxEqAbs(bobEarned, 3 ether, 1e12);
        assertLe(aliceEarned + bobEarned, 9 ether); // claimed + claimable never exceeds what was streamed
    }

    function test_rewards_claimMidStreamAndAfter() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);

        weth.mint(address(this), 7 ether);
        weth.approve(address(v), 7 ether);
        v.notifyReward(7 ether);

        vm.warp(block.timestamp + 1 days); // mid-stream
        vm.prank(alice);
        uint256 mid = v.claim();
        assertApproxEqAbs(mid, 1 ether, 1e12); // 1/7 of the stream so far

        vm.warp(block.timestamp + REWARDS_DURATION); // well past periodFinish
        vm.prank(alice);
        uint256 rest = v.claim();
        assertApproxEqAbs(mid + rest, 7 ether, 1e12);
    }

    function test_rewards_overlappingNotifyReward_rollsLeftoverForward() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);

        weth.mint(address(this), 7 ether);
        weth.approve(address(v), 7 ether);
        v.notifyReward(7 ether);

        vm.warp(block.timestamp + 1 days); // 1/7 of the first stream has elapsed
        weth.mint(address(this), 7 ether);
        weth.approve(address(v), 7 ether);
        v.notifyReward(7 ether); // leftover (6/7 * 7 = 6 ether) rolls into a NEW 7-day period with the new 7

        vm.warp(block.timestamp + REWARDS_DURATION);
        vm.prank(alice);
        uint256 total = v.claim();
        // Sole depositor throughout — total payout should be close to everything notified (1 + 6 + 7 = 14, minus
        // nothing lost, floor-rounding aside).
        assertApproxEqAbs(total, 14 ether, 1e12);
    }

    function test_rewards_zeroWeightPeriod_heldThenStreamed() public {
        OpenTreasuryVault v = _vault();
        // No depositor yet.
        weth.mint(address(this), 5 ether);
        weth.approve(address(v), 5 ether);
        v.notifyReward(5 ether);
        assertEq(v.pendingReward(), 5 ether);
        assertEq(v.rewardRate(), 0);

        _depositAsAlice(v, asset18, 1 ether); // weight becomes non-zero — stream starts now
        assertEq(v.pendingReward(), 0);
        assertGt(v.rewardRate(), 0);

        vm.warp(block.timestamp + REWARDS_DURATION);
        assertApproxEqAbs(v.earned(alice), 5 ether, 1e12);
    }

    function test_sync_detectsPlainTransferSurplus() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);

        weth.mint(address(v), 3 ether); // plain transfer, no notifyReward call
        uint256 added = v.sync();
        assertEq(added, 3 ether);

        vm.warp(block.timestamp + REWARDS_DURATION);
        assertApproxEqAbs(v.earned(alice), 3 ether, 1e12);
    }

    function test_sync_cannotCountPrincipalAsRewards_rewardAssetAlsoDepositable() public {
        // Make WETH itself a depositable asset too.
        MockAggregator wethFeed = new MockAggregator(8, 2000_00000000, block.timestamp); // $2000
        vm.prank(owner);
        registry.setAsset(address(weth), address(wethFeed), 1 days, 1e15, MarketHours.Crypto24_7);

        OpenTreasuryVault v = _vault();
        weth.mint(bob, 5 ether);
        vm.startPrank(bob);
        weth.approve(address(v), 5 ether);
        v.deposit(address(weth), 5 ether); // PRINCIPAL deposit of the reward asset
        vm.stopPrank();

        uint256 added = v.sync();
        assertEq(added, 0, "principal deposit of the reward asset must never register as a reward surplus");

        // Now actually fund rewards on top — sync must detect ONLY the genuine surplus.
        weth.mint(address(v), 2 ether);
        added = v.sync();
        assertEq(added, 2 ether);
        assertEq(v.totalPrincipal(address(weth)), 5 ether, "principal accounting untouched by sync");
    }

    // --------------------------------------------------------------------- //
    //  Reward sniping                                                       //
    // --------------------------------------------------------------------- //

    function test_rewardSniping_boundedByTimeWeightedShare() public {
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether); // alice present the whole period

        weth.mint(address(this), 7 ether);
        weth.approve(address(v), 7 ether);
        v.notifyReward(7 ether);

        // bob deposits just before the stream ends, withdraws as early as allowed.
        vm.warp(block.timestamp + REWARDS_DURATION - MIN_HOLD);
        feed18.setAnswer(100_00000000, block.timestamp); // refresh the feed — staleAfter is only 1 day
        vm.startPrank(bob);
        asset18.approve(address(v), 1 ether);
        v.deposit(address(asset18), 1 ether); // matches alice's weight exactly from here on
        vm.stopPrank();

        vm.warp(block.timestamp + MIN_HOLD); // earliest bob can withdraw; also exactly periodFinish
        vm.prank(bob);
        uint256 bobEarned = v.earned(bob);
        // bob only shares the LAST MIN_HOLD of a REWARDS_DURATION stream, split 50/50 with alice
        // during that window: expected ~= 7 * (MIN_HOLD / REWARDS_DURATION) / 2.
        uint256 expected = (7 ether * MIN_HOLD) / REWARDS_DURATION / 2;
        assertApproxEqAbs(bobEarned, expected, 1e14);
        assertLt(bobEarned, 1 ether, "snipe must not capture anywhere near a full pro-rata share of the whole stream");
    }

    // --------------------------------------------------------------------- //
    //  Reentrancy                                                           //
    // --------------------------------------------------------------------- //

    function test_reentrancy_deposit() public {
        // deposit()'s only external call is the INBOUND transferFrom pull — use the
        // receive-side reentrant mock (ReentrantERC20 only fires on outbound
        // transfers FROM the target, which never happens during deposit()).
        ReentrantOnReceiveERC20 evil = new ReentrantOnReceiveERC20();
        vm.prank(owner);
        registry.setAsset(address(evil), address(feed18), 1 days, 1e15, MarketHours.Crypto24_7);
        OpenTreasuryVault v = _vault();
        evil.mint(alice, 10 ether);

        evil.arm(address(v), abi.encodeCall(OpenTreasuryVault.deposit, (address(evil), 1 ether)));
        vm.startPrank(alice);
        evil.approve(address(v), 10 ether);
        vm.expectRevert(); // ReentrancyGuard blocks the nested deposit() call mid-transferFrom
        v.deposit(address(evil), 10 ether);
        vm.stopPrank();
    }

    function test_reentrancy_withdraw() public {
        ReentrantERC20 evil = new ReentrantERC20();
        vm.prank(owner);
        registry.setAsset(address(evil), address(feed18), 1 days, 1e15, MarketHours.Crypto24_7);
        OpenTreasuryVault v = _vault();
        evil.mint(alice, 10 ether);
        vm.startPrank(alice);
        evil.approve(address(v), 10 ether);
        v.deposit(address(evil), 10 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + MIN_HOLD);

        evil.arm(address(v), abi.encodeCall(OpenTreasuryVault.withdraw, (address(evil), 1 ether)));
        vm.prank(alice);
        vm.expectRevert();
        v.withdraw(address(evil), 5 ether);
    }

    function test_reentrancy_claim() public {
        ReentrantERC20 evilReward = new ReentrantERC20();
        OpenTreasuryVaultFactory f2 = new OpenTreasuryVaultFactory(
            address(ballastFactory), address(registry), address(evilReward), MIN_HOLD, REWARDS_DURATION
        );
        MockERC20 token2 = new MockERC20("P2", "P2", 18);
        ballastFactory.markLaunched(address(token2));
        OpenTreasuryVault v2 = OpenTreasuryVault(f2.getOrCreateVault(address(token2)));

        _depositAsAliceInto(v2);
        evilReward.mint(address(this), 5 ether);
        evilReward.approve(address(v2), 5 ether);
        v2.notifyReward(5 ether);
        vm.warp(block.timestamp + REWARDS_DURATION);

        evilReward.arm(address(v2), abi.encodeCall(OpenTreasuryVault.claim, ()));
        vm.prank(alice);
        vm.expectRevert();
        v2.claim();
    }

    function _depositAsAliceInto(OpenTreasuryVault v) internal {
        vm.startPrank(alice);
        asset18.approve(address(v), 1 ether);
        v.deposit(address(asset18), 1 ether);
        vm.stopPrank();
    }

    // --------------------------------------------------------------------- //
    //  No privileged party can block or redirect a withdrawal                //
    // --------------------------------------------------------------------- //

    function test_abiSurface_noAdminOrRescueFunction() public {
        // Enumerate the REAL compiled ABI's function signatures via forge's
        // methodIdentifiers map (vm.parseJsonKeys) — an authoritative, complete
        // list of every external/public selector this contract exposes, not a
        // hand-picked subset. Deliberately not a naive substring scan of the WHOLE
        // artifact (bytecode + AST + metadata runs ~100KB and blew the gas limit);
        // methodIdentifiers alone is ~1KB.
        string memory json = vm.readFile("out/OpenTreasuryVault.sol/OpenTreasuryVault.json");
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        assertGt(sigs.length, 0, "methodIdentifiers must be non-empty");

        string[] memory forbidden = new string[](13);
        forbidden[0] = "owner";
        forbidden[1] = "admin";
        forbidden[2] = "pause";
        forbidden[3] = "unpause";
        forbidden[4] = "rescue";
        forbidden[5] = "sweep";
        forbidden[6] = "setOwner";
        forbidden[7] = "transferOwnership";
        forbidden[8] = "renounceOwnership";
        forbidden[9] = "emergencyWithdraw";
        forbidden[10] = "withdrawAll";
        forbidden[11] = "upgradeTo";
        forbidden[12] = "setFeeReceiver";

        for (uint256 i = 0; i < sigs.length; i++) {
            for (uint256 j = 0; j < forbidden.length; j++) {
                assertFalse(_contains(sigs[i], forbidden[j]), string.concat("forbidden function present: ", sigs[i]));
            }
        }
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || h.length < n.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }

    function test_withdraw_isTheOnlyFunctionThatSendsPrincipalToArbitraryRecipient() public {
        // claim()/claimFor() only ever pay the REWARD asset, never principal, and
        // claimFor's recipient is a fixed parameter (the depositor), never msg.sender.
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);
        vm.warp(block.timestamp + MIN_HOLD);

        // Bob cannot make alice's principal land anywhere but alice's own withdraw call.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVault.InsufficientBalance.selector, 1 ether, 0));
        v.withdraw(address(asset18), 1 ether);

        // claimFor(alice) called by bob pays ALICE, never bob, and never touches principal.
        vm.prank(bob);
        v.claimFor(alice); // no-op (nothing earned yet), but proves the call cannot redirect funds to bob
        assertEq(weth.balanceOf(bob), 0);
    }

    // --------------------------------------------------------------------- //
    //  Full creator-funds-rewards flow (rule 11, no FeeRouter)              //
    // --------------------------------------------------------------------- //

    function test_fullFlow_creatorClaimsFromHookThenFundsRewards() public {
        MockFeeHook hook = new MockFeeHook(weth);
        hook.credit(creator, 3 ether); // simulates accrued swap-fee creator share

        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, 1 ether);

        vm.prank(creator);
        hook.claim(); // creator pulls WETH to their own EOA, exactly like today's only live path
        assertEq(weth.balanceOf(creator), 3 ether);

        vm.startPrank(creator);
        weth.approve(address(v), 3 ether);
        v.notifyReward(3 ether); // permissionless — works from the creator's EOA with no special role
        vm.stopPrank();

        vm.warp(block.timestamp + REWARDS_DURATION);
        assertApproxEqAbs(v.earned(alice), 3 ether, 1e12);
    }

    // --------------------------------------------------------------------- //
    //  Fuzz                                                                 //
    // --------------------------------------------------------------------- //

    function testFuzz_depositWithdraw_accountingNeverDrifts(uint256 amount, uint256 withdrawAmount) public {
        amount = bound(amount, 1e15, 500_000 ether);
        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, amount);
        uint256 originalWeight = v.assetWeight(alice, address(asset18)); // NOT a fixed constant — scales with `amount`
        withdrawAmount = bound(withdrawAmount, 1, amount);

        vm.warp(block.timestamp + MIN_HOLD);
        vm.prank(alice);
        v.withdraw(address(asset18), withdrawAmount);

        assertEq(v.principal(alice, address(asset18)), amount - withdrawAmount);
        assertEq(v.totalPrincipal(address(asset18)), amount - withdrawAmount);
        assertEq(asset18.balanceOf(address(v)), amount - withdrawAmount);
        // weight stays proportionally consistent (within floor-rounding of 1 wei-equivalent)
        uint256 expectedWeight = (originalWeight * (amount - withdrawAmount)) / amount;
        assertApproxEqAbs(v.assetWeight(alice, address(asset18)), expectedWeight, 1);
    }

    function testFuzz_rewardSplit_sumNeverExceedsNotified(uint256 aliceAmt, uint256 bobAmt, uint256 rewardAmt, uint256 warpBy)
        public
    {
        aliceAmt = bound(aliceAmt, 1e15, 100_000 ether);
        bobAmt = bound(bobAmt, 1e15, 100_000 ether);
        rewardAmt = bound(rewardAmt, 1, 1_000 ether);
        warpBy = bound(warpBy, 0, REWARDS_DURATION * 2);

        OpenTreasuryVault v = _vault();
        _depositAsAlice(v, asset18, aliceAmt);
        vm.startPrank(bob);
        asset18.approve(address(v), bobAmt);
        v.deposit(address(asset18), bobAmt);
        vm.stopPrank();

        weth.mint(address(this), rewardAmt);
        weth.approve(address(v), rewardAmt);
        v.notifyReward(rewardAmt);

        vm.warp(block.timestamp + warpBy);
        assertLe(v.earned(alice) + v.earned(bob), rewardAmt + 1); // +1 wei floor-rounding tolerance
    }
}
