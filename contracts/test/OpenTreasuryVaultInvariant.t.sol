// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OpenTreasuryVault} from "../src/OpenTreasuryVault.sol";
import {OpenTreasuryVaultFactory} from "../src/OpenTreasuryVaultFactory.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockBallastFactoryLaunchId} from "./mocks/MockBallastFactoryLaunchId.sol";

/// @dev Drives random valid sequences of deposit/withdraw/claim/notifyReward/sync
///      across multiple depositors and assets, tracking ghost totals, so the
///      invariants below hold under ANY ordering (matches ProjectTreasuryInvariant's
///      handler shape).
contract OpenTreasuryHandler is Test {
    OpenTreasuryVault public v;
    MockERC20 public asset18;
    MockERC20 public asset6;
    MockERC20 public weth;
    uint256 public minHold;
    uint256 public rewardsDuration;

    address[3] public depositors = [makeAddr("d0"), makeAddr("d1"), makeAddr("d2")];
    address public notifier = makeAddr("notifier");

    uint256 public gDeposited18;
    uint256 public gWithdrawn18;
    uint256 public gDeposited6;
    uint256 public gWithdrawn6;
    uint256 public gRewardAdded;
    uint256 public gClaimed;

    uint256 constant MINTED = 1e30;

    constructor(OpenTreasuryVault v_, MockERC20 asset18_, MockERC20 asset6_, MockERC20 weth_, uint256 minHold_, uint256 rewardsDuration_) {
        v = v_;
        asset18 = asset18_;
        asset6 = asset6_;
        weth = weth_;
        minHold = minHold_;
        rewardsDuration = rewardsDuration_;

        for (uint256 i = 0; i < depositors.length; i++) {
            asset18.mint(depositors[i], MINTED);
            asset6.mint(depositors[i], MINTED);
            vm.startPrank(depositors[i]);
            asset18.approve(address(v), type(uint256).max);
            asset6.approve(address(v), type(uint256).max);
            vm.stopPrank();
        }
        weth.mint(notifier, MINTED);
        vm.prank(notifier);
        weth.approve(address(v), type(uint256).max);
    }

    function deposit18(uint256 who, uint256 amt) public {
        address d = depositors[who % depositors.length];
        amt = bound(amt, 1e15, 1e24);
        if (asset18.balanceOf(d) < amt) return;
        vm.prank(d);
        v.deposit(address(asset18), amt);
        gDeposited18 += amt;
    }

    function deposit6(uint256 who, uint256 amt) public {
        address d = depositors[who % depositors.length];
        amt = bound(amt, 1e4, 1e12);
        if (asset6.balanceOf(d) < amt) return;
        vm.prank(d);
        v.deposit(address(asset6), amt);
        gDeposited6 += amt;
    }

    function withdraw18(uint256 who, uint256 amt, uint256 warpBy) public {
        address d = depositors[who % depositors.length];
        uint256 bal = v.principal(d, address(asset18));
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.warp(block.timestamp + minHold + bound(warpBy, 0, 3 days));
        uint256 unlockAt = v.pendingWithdrawAt(d, address(asset18));
        if (block.timestamp < unlockAt) return;
        vm.prank(d);
        v.withdraw(address(asset18), amt);
        gWithdrawn18 += amt;
    }

    function withdraw6(uint256 who, uint256 amt, uint256 warpBy) public {
        address d = depositors[who % depositors.length];
        uint256 bal = v.principal(d, address(asset6));
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.warp(block.timestamp + minHold + bound(warpBy, 0, 3 days));
        uint256 unlockAt = v.pendingWithdrawAt(d, address(asset6));
        if (block.timestamp < unlockAt) return;
        vm.prank(d);
        v.withdraw(address(asset6), amt);
        gWithdrawn6 += amt;
    }

    function claim(uint256 who) public {
        address d = depositors[who % depositors.length];
        vm.prank(d);
        uint256 amt = v.claim();
        gClaimed += amt;
    }

    function notifyReward(uint256 amt) public {
        amt = bound(amt, 1, 100 ether);
        vm.prank(notifier);
        v.notifyReward(amt);
        gRewardAdded += amt;
    }

    function sync(uint256 amt) public {
        amt = bound(amt, 0, 50 ether);
        if (amt > 0) {
            vm.prank(notifier);
            weth.transfer(address(v), amt);
        }
        uint256 added = v.sync();
        gRewardAdded += added;
    }

    function warp(uint256 by) public {
        vm.warp(block.timestamp + bound(by, 0, 10 days));
    }

    function depositorsLength() external view returns (uint256) {
        return depositors.length;
    }
}

contract OpenTreasuryVaultInvariantTest is Test {
    OpenTreasuryVault vault;
    OpenTreasuryVaultFactory factory;
    AssetRegistry registry;
    MockBallastFactoryLaunchId ballastFactory;
    MockERC20 token;
    MockERC20 weth;
    MockERC20 asset18;
    MockERC20 asset6;
    OpenTreasuryHandler handler;

    address owner = makeAddr("owner");
    uint256 constant MIN_HOLD = 24 hours;
    uint256 constant REWARDS_DURATION = 7 days;

    function setUp() public {
        registry = new AssetRegistry(owner);
        ballastFactory = new MockBallastFactoryLaunchId();
        weth = new MockERC20("WETH", "WETH", 18);
        token = new MockERC20("Project", "PRJ", 18);
        ballastFactory.markLaunched(address(token));

        factory = new OpenTreasuryVaultFactory(address(ballastFactory), address(registry), address(weth), MIN_HOLD, REWARDS_DURATION);

        asset18 = new MockERC20("Asset18", "A18", 18);
        MockAggregator feed18 = new MockAggregator(8, 100_00000000, block.timestamp);
        vm.prank(owner);
        registry.setAsset(address(asset18), address(feed18), 3650 days, 1e15, MarketHours.UsEquities24_5);

        asset6 = new MockERC20("Asset6", "A6", 6);
        MockAggregator feed6 = new MockAggregator(8, 50_00000000, block.timestamp);
        vm.prank(owner);
        registry.setAsset(address(asset6), address(feed6), 3650 days, 1e4, MarketHours.UsEquities24_5);

        vault = OpenTreasuryVault(factory.getOrCreateVault(address(token)));
        handler = new OpenTreasuryHandler(vault, asset18, asset6, weth, MIN_HOLD, REWARDS_DURATION);
        targetContract(address(handler));
    }

    /// Per asset, the vault's real balance always covers every depositor's principal.
    function invariant_vaultCoversAllPrincipal() public view {
        assertGe(asset18.balanceOf(address(vault)), vault.totalPrincipal(address(asset18)), "asset18 shortfall");
        assertGe(asset6.balanceOf(address(vault)), vault.totalPrincipal(address(asset6)), "asset6 shortfall");
    }

    /// Principal accounting exactly matches ghost deposited-minus-withdrawn, for each asset.
    function invariant_principalAccountingMatchesGhosts() public view {
        assertEq(vault.totalPrincipal(address(asset18)), handler.gDeposited18() - handler.gWithdrawn18());
        assertEq(vault.totalPrincipal(address(asset6)), handler.gDeposited6() - handler.gWithdrawn6());
    }

    /// totalWeight always equals the sum of each depositor's own weight.
    function invariant_totalWeightMatchesSum() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.depositorsLength(); i++) {
            sum += vault.weightOf(handler.depositors(i));
        }
        assertEq(vault.totalWeight(), sum);
    }

    /// Claimed + currently-claimable can never exceed total rewards ever added to
    /// the stream (notifyReward + sync combined) — small floor-rounding slack only.
    function invariant_claimedPlusClaimableNeverExceedsReceived() public view {
        uint256 claimable;
        for (uint256 i = 0; i < handler.depositorsLength(); i++) {
            claimable += vault.earned(handler.depositors(i));
        }
        assertLe(handler.gClaimed() + claimable, handler.gRewardAdded() + handler.depositorsLength());
    }

    /// The reward asset's real balance always covers the outstanding reward
    /// liability (streamed-or-not, minus already claimed) plus any principal of
    /// the reward asset itself (not applicable here since weth is not registered
    /// as a depositable asset in this handler, but checked for completeness).
    function invariant_rewardAssetBalanceCoversLiability() public view {
        uint256 liability = vault.totalRewardDeposited() - vault.totalRewardClaimed();
        assertGe(weth.balanceOf(address(vault)), liability + vault.totalPrincipal(address(weth)));
    }
}
