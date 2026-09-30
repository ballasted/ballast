// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HolderStakingVault} from "../src/HolderStakingVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract HolderStakingVaultTest is Test {
    HolderStakingVault vault;
    MockERC20 token;
    MockERC20 weth;

    address router = address(this); // this test contract plays the router
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        token = new MockERC20("Project", "PRJ", 18);
        weth = new MockERC20("WETH", "WETH", 18);
        vault = new HolderStakingVault(address(token), address(weth), router);

        token.mint(alice, 1_000 ether);
        token.mint(bob, 1_000 ether);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    function _notify(uint256 amount) internal {
        weth.mint(address(vault), amount);
        vault.notifyReward(amount);
    }

    // --------------------------------------------------------------------- //
    //  Access control + basic accounting                                    //
    // --------------------------------------------------------------------- //

    function test_notifyReward_onlyRouter() public {
        vm.prank(alice);
        vm.expectRevert(HolderStakingVault.NotRouter.selector);
        vault.notifyReward(1 ether);
    }

    function test_stake_zeroAmount_reverts() public {
        vm.prank(alice);
        vm.expectRevert(HolderStakingVault.ZeroAmount.selector);
        vault.stake(0);
    }

    function test_unstake_moreThanBalance_reverts() public {
        vm.prank(alice);
        vault.stake(10 ether);
        vm.prank(alice);
        vm.expectRevert(HolderStakingVault.InsufficientBalance.selector);
        vault.unstake(11 ether);
    }

    function test_unstake_anytime_noLockup() public {
        vm.prank(alice);
        vault.stake(10 ether);
        vm.prank(alice);
        vault.unstake(10 ether); // no warp, no notice period — succeeds immediately
        assertEq(token.balanceOf(alice), 1_000 ether);
        assertEq(vault.totalStaked(), 0);
    }

    // --------------------------------------------------------------------- //
    //  notifyReward while totalStaked == 0 — must not strand or divide by zero //
    // --------------------------------------------------------------------- //

    function test_notifyReward_zeroStaked_carriesAsPending() public {
        _notify(1 ether);
        assertEq(vault.pendingReward(), 1 ether);
        assertEq(vault.rewardPerTokenStored(), 0);
        assertEq(vault.totalRewardsNotified(), 0);

        // Weth sits in the vault, unstranded, waiting for a staker.
        assertEq(weth.balanceOf(address(vault)), 1 ether);
    }

    function test_notifyReward_pendingFoldsIntoNextNotifyOnceStaked() public {
        _notify(1 ether); // totalStaked == 0 -> pending
        vm.prank(alice);
        vault.stake(10 ether);

        _notify(2 ether); // now totalStaked > 0 -> folds in pending (1) + new (2) = 3
        assertEq(vault.pendingReward(), 0);
        assertEq(vault.totalRewardsNotified(), 3 ether);
        assertEq(vault.claimable(alice), 3 ether); // sole staker gets all of it
    }

    // --------------------------------------------------------------------- //
    //  Late stakers only earn from their stake point forward                //
    // --------------------------------------------------------------------- //

    function test_lateStaker_doesNotEarnPriorReward() public {
        vm.prank(alice);
        vault.stake(10 ether);
        _notify(10 ether); // alice alone earns this fully

        vm.prank(bob);
        vault.stake(10 ether); // joins AFTER the first reward

        assertEq(vault.claimable(alice), 10 ether);
        assertEq(vault.claimable(bob), 0);

        _notify(10 ether); // now split 50/50 between alice and bob
        assertEq(vault.claimable(alice), 15 ether);
        assertEq(vault.claimable(bob), 5 ether);
    }

    function test_claim_paysAndZeroesOnlyThatUser() public {
        vm.prank(alice);
        vault.stake(10 ether);
        _notify(10 ether);

        vm.prank(alice);
        uint256 paid = vault.claim();

        assertEq(paid, 10 ether);
        assertEq(weth.balanceOf(alice), 10 ether);
        assertEq(vault.claimable(alice), 0);
        vm.prank(alice);
        assertEq(vault.claim(), 0); // idempotent — nothing left
    }

    // --------------------------------------------------------------------- //
    //  Unstake mid-stream                                                   //
    // --------------------------------------------------------------------- //

    function test_unstakeMidStream_rewardsSplitByBalanceAtEachPeriod() public {
        vm.prank(alice);
        vault.stake(10 ether);
        vm.prank(bob);
        vault.stake(10 ether);

        _notify(20 ether); // 50/50 -> 10 each
        assertEq(vault.claimable(alice), 10 ether);
        assertEq(vault.claimable(bob), 10 ether);

        // Alice exits entirely; her accrued 10 must survive the unstake unpaid
        // (checkpointed into `rewards`, not lost) and bob keeps earning alone.
        vm.prank(alice);
        vault.unstake(10 ether);

        _notify(10 ether); // only bob is staked now -> all 10 to bob
        assertEq(vault.claimable(alice), 10 ether); // unchanged, still claimable
        assertEq(vault.claimable(bob), 20 ether); // 10 + 10
    }

    function test_partialUnstake_reducesFutureShareProportionally() public {
        vm.prank(alice);
        vault.stake(30 ether);
        vm.prank(bob);
        vault.stake(10 ether); // alice 75%, bob 25%

        vm.prank(alice);
        vault.unstake(20 ether); // now alice 10, bob 10 -> 50/50

        _notify(20 ether);
        assertEq(vault.claimable(alice), 10 ether);
        assertEq(vault.claimable(bob), 10 ether);
    }
}
