// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BackingLens} from "../src/BackingLens.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";

/// @dev Valuation tests. The invariants under test are the ones that silently
///      corrupt every number on the platform if broken: reverting on stale
///      prices, double-counting the uiMultiplier, hardcoding decimals, trusting a
///      price during a sequencer outage.
contract BackingLensTest is Test {
    AssetRegistry registry;
    ProjectTreasury treasury;
    BackingLens lens;

    MockERC20 projectToken;
    MockERC20 nvda; // 18-decimal stock token
    MockAggregator nvdaFeed; // 8-decimal USD feed
    MockAggregator sequencer; // uptime feed

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    uint256 constant NOTICE = 30 days;
    uint256 constant MIN_DEP = 1e18;
    uint256 constant EQUITY_STALE_AFTER = 3 days; // must survive a weekend
    bytes32 constant DISCLOSURE = keccak256("v1");

    // Start at a realistic timestamp so `block.timestamp - startedAt` math is sane.
    uint256 constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);

        registry = new AssetRegistry(owner);
        projectToken = new MockERC20("Project", "PRJ", 18);
        projectToken.mint(address(0xdead), 1_000_000e18); // fixed supply = 1,000,000

        nvda = new MockERC20("NVDA Stock Token", "NVDA", 18);
        nvdaFeed = new MockAggregator(8, 100e8, T0); // $100.00, fresh

        vm.prank(owner);
        registry.setAsset(address(nvda), address(nvdaFeed), EQUITY_STALE_AFTER, MIN_DEP);

        treasury = new ProjectTreasury(address(projectToken), creator, NOTICE, address(registry));

        // Sequencer up, recovered long ago (past the grace period).
        sequencer = new MockAggregator(0, 0, T0 - 10 days);
        lens = new BackingLens(address(sequencer));

        nvda.mint(creator, 1_000_000e18);
        nvda.mint(alice, 1_000_000e18);
        vm.prank(creator);
        nvda.approve(address(treasury), type(uint256).max);
        vm.prank(alice);
        nvda.approve(address(treasury), type(uint256).max);
    }

    // ===================================================================== //
    //  Core valuation math                                                 //
    // ===================================================================== //

    function test_backingPerToken_basic() public {
        // 1000 NVDA @ $100 = $100,000 over 1,000,000 supply = $0.10 backing/token.
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertEq(b.totalValueUsd, 100_000e18);
        assertEq(b.backingPerToken, 0.1e18);
        assertEq(b.withdrawableValueUsd, 100_000e18);
        assertEq(b.lockedValueUsd, 0);
        assertFalse(b.anyStale);
        assertFalse(b.anyUnpriced);
    }

    function test_lockedVsWithdrawable_reportedSeparately() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 400e18); // withdrawable

        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 600e18, DISCLOSURE);
        vm.prank(creator);
        treasury.acceptDeposit(id); // locked forever

        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertEq(b.withdrawableValueUsd, 40_000e18);
        assertEq(b.lockedValueUsd, 60_000e18);
        assertEq(b.totalValueUsd, 100_000e18);
        assertEq(b.lockedBackingPerToken, 0.06e18);
        assertEq(b.backingPerToken, 0.1e18);
    }

    // ===================================================================== //
    //  HARD RULE: never revert on a stale (off-hours) price                //
    // ===================================================================== //

    function test_stalePrice_flagsButDoesNotRevert_andStillCounts() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        // Simulate a weekend: last update 2.5 days ago, no new heartbeat.
        vm.warp(T0 + 2.5 days);
        // feed still holds $100 from T0.

        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertFalse(b.anyStale, "2.5 days < 3 day bound: not yet stale");
        assertEq(b.totalValueUsd, 100_000e18, "held price still valued");

        // Push past the staleness bound: flagged, but STILL valued (not dropped).
        vm.warp(T0 + 4 days);
        b = lens.backingOf(address(treasury));
        assertTrue(b.anyStale, "now flagged stale");
        assertTrue(b.assets[0].priced, "stale != unpriced");
        assertEq(b.totalValueUsd, 100_000e18, "stale price must NOT be dropped");
    }

    // ===================================================================== //
    //  HARD RULE: reject zero/negative answers                             //
    // ===================================================================== //

    function test_zeroAnswer_marksUnpricedNotReverts() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        nvdaFeed.setAnswer(0, block.timestamp);
        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertTrue(b.anyUnpriced);
        assertFalse(b.assets[0].priced);
        assertEq(b.totalValueUsd, 0, "invalid price excluded from totals");
    }

    function test_negativeAnswer_marksUnpriced() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        nvdaFeed.setAnswer(-5, block.timestamp);
        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertTrue(b.anyUnpriced);
        assertEq(b.totalValueUsd, 0);
    }

    function test_revertingFeed_isContained() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        nvdaFeed.setRevert(true);
        // Whole-treasury view must not blow up because one feed reverts.
        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertTrue(b.anyUnpriced);
        assertEq(b.totalValueUsd, 0);
    }

    // ===================================================================== //
    //  HARD RULE: read decimals() from the feed, never hardcode            //
    // ===================================================================== //

    function test_nonEightDecimalFeed_valuedCorrectly() public {
        // A feed reporting 18 decimals instead of the usual 8.
        MockAggregator feed18 = new MockAggregator(18, 100e18, block.timestamp);
        MockERC20 tsla = new MockERC20("TSLA", "TSLA", 18);
        vm.prank(owner);
        registry.setAsset(address(tsla), address(feed18), EQUITY_STALE_AFTER, MIN_DEP);
        tsla.mint(creator, 1_000_000e18);
        vm.prank(creator);
        tsla.approve(address(treasury), type(uint256).max);

        vm.prank(creator);
        treasury.deposit(address(tsla), 1000e18); // 1000 @ $100 = $100,000

        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertEq(b.totalValueUsd, 100_000e18, "18-decimal feed valued the same as 8-decimal");
        assertEq(b.assets[0].priceDecimals, 18);
    }

    function test_sixDecimalAsset_valuedCorrectly() public {
        // A 6-decimal asset (e.g. a USDC-like) with an 8-decimal $1 feed.
        MockAggregator usdcFeed = new MockAggregator(8, 1e8, block.timestamp);
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.prank(owner);
        registry.setAsset(address(usdc), address(usdcFeed), 1 days, 1e6);
        usdc.mint(creator, 1_000_000e6);
        vm.prank(creator);
        usdc.approve(address(treasury), type(uint256).max);

        vm.prank(creator);
        treasury.deposit(address(usdc), 50_000e6); // $50,000

        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertEq(b.totalValueUsd, 50_000e18);
    }

    // ===================================================================== //
    //  HARD RULE: check the sequencer before trusting any price            //
    // ===================================================================== //

    function test_sequencerDown_marksAllUnpriced() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        sequencer.setAnswer(1, block.timestamp); // 1 = down
        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertFalse(b.sequencerUp);
        assertTrue(b.anyUnpriced);
        assertEq(b.totalValueUsd, 0, "no price trusted while sequencer down");
    }

    function test_sequencerGracePeriod_marksUnpriced() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        // Sequencer just recovered: up, but within the grace window.
        sequencer.setAnswer(0, block.timestamp);
        sequencer.setStartedAt(block.timestamp - 10 minutes); // < 1h grace
        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertTrue(b.sequencerUp);
        assertTrue(b.sequencerGraceActive);
        assertEq(b.totalValueUsd, 0, "grace period: prices not yet trusted");

        // After the grace window, prices resume.
        sequencer.setStartedAt(block.timestamp - 2 hours);
        b = lens.backingOf(address(treasury));
        assertFalse(b.sequencerGraceActive);
        assertEq(b.totalValueUsd, 100_000e18);
    }

    // ===================================================================== //
    //  priceOf (spec §5)                                                    //
    // ===================================================================== //

    function test_priceOf_returnsStaleFlag_noRevert() public {
        vm.warp(T0 + 4 days);
        (uint256 price, uint256 updatedAt, bool stale) = lens.priceOf(address(registry), address(nvda));
        assertEq(price, 100e8);
        assertEq(updatedAt, T0);
        assertTrue(stale);
    }

    function test_priceOf_revertsOnInvalidAnswer() public {
        nvdaFeed.setAnswer(0, block.timestamp);
        vm.expectRevert(bytes("invalid price"));
        lens.priceOf(address(registry), address(nvda));
    }

    // ===================================================================== //
    //  Empty / edge treasuries                                             //
    // ===================================================================== //

    function test_emptyTreasury_returnsZeroNoRevert() public view {
        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertEq(b.totalValueUsd, 0);
        assertEq(b.backingPerToken, 0);
        assertEq(b.assets.length, 0);
    }

    // ===================================================================== //
    //  Valuation must survive an issuer-paused token — reads are NOT gated  //
    // ===================================================================== //

    function test_valuation_survivesPausedAndBlockedToken() public {
        MockStockToken sgov = new MockStockToken("SGOV Robinhood Token", "SGOV", 18);
        MockAggregator sgovFeed = new MockAggregator(8, 100e8, block.timestamp); // $100
        vm.prank(owner);
        registry.setAsset(address(sgov), address(sgovFeed), EQUITY_STALE_AFTER, MIN_DEP);
        sgov.mint(creator, 1_000_000e18);
        vm.prank(creator);
        sgov.approve(address(treasury), type(uint256).max);

        vm.prank(creator);
        treasury.deposit(address(sgov), 1000e18); // $100,000

        // Issuer pauses transfers AND flags the corporate-action oracle. Reads
        // (balanceOf/totalSupply/decimals/oraclePaused) are ungated, so valuation
        // must still compute — it must NEVER revert.
        sgov.setPaused(true);
        sgov.setOraclePaused(true);
        sgov.setBlocked(address(treasury), true);

        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertEq(b.totalValueUsd, 100_000e18, "paused token still valued from ungated reads");
        assertTrue(b.assets[0].priced);
        assertTrue(b.assets[0].oraclePaused, "oraclePaused surfaced as a UI flag");
        assertFalse(b.anyUnpriced);
    }

    function test_delistedAssetAfterDeposit_shownUnpriced() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 1000e18);

        vm.prank(owner);
        registry.removeAsset(address(nvda)); // feed lookup now returns address(0)

        BackingLens.Backing memory b = lens.backingOf(address(treasury));
        assertEq(b.assets.length, 1);
        assertFalse(b.assets[0].priced);
        assertEq(b.assets[0].lockedBalance + b.assets[0].withdrawableBalance, 1000e18, "balance still shown");
        assertEq(b.totalValueUsd, 0);
    }
}
