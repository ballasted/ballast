// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Tests the treasury against a token that models the real Robinhood Stock
///      Token access-control gate (paused + isBlocked), discovered by the Session 0
///      probe. The central worry: a transfer-based recovery path (reclaim/decline/
///      execute) could strand funds if the token is paused. It does not — every
///      such path uses checks-effects-interactions with a revert-on-failure
///      transfer, so a paused token makes the whole call revert ATOMICALLY,
///      leaving the queue/withdrawal entry intact and re-callable once transfers
///      resume. These tests enforce exactly that.
contract ProjectTreasuryGatedTest is Test {
    AssetRegistry registry;
    ProjectTreasury treasury;
    MockStockToken sgov;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    MockERC20 projectToken;

    uint256 constant NOTICE = 30 days;
    uint256 constant MIN_DEP = 1e15;
    bytes32 constant DISCLOSURE = keccak256("v1");

    function setUp() public {
        registry = new AssetRegistry(owner);
        projectToken = new MockERC20("Project", "PRJ", 18);
        sgov = new MockStockToken("SGOV Robinhood Token", "SGOV", 18);

        vm.prank(owner);
        registry.setAsset(address(sgov), address(0xFEED), 3 days, MIN_DEP);

        treasury = new ProjectTreasury(address(projectToken), creator, NOTICE, address(registry));

        sgov.mint(creator, 100e18);
        sgov.mint(alice, 100e18);
        vm.prank(creator);
        sgov.approve(address(treasury), type(uint256).max);
        vm.prank(alice);
        sgov.approve(address(treasury), type(uint256).max);
    }

    // ===================================================================== //
    //  Withdrawal survives a mid-flow pause and stays re-callable           //
    // ===================================================================== //

    function test_executeWithdrawal_pausedMidFlow_isReCallable() public {
        vm.prank(creator);
        treasury.deposit(address(sgov), 10e18);
        vm.prank(creator);
        uint256 id = treasury.announceWithdrawal(address(sgov), 5e18);

        // Notice period elapses, THEN the issuer pauses the token.
        vm.warp(block.timestamp + NOTICE);
        sgov.setPaused(true);

        // Execution reverts on the transfer — atomically.
        vm.prank(creator);
        vm.expectRevert(MockStockToken.TransfersPaused.selector);
        treasury.executeWithdrawal(id);

        // Nothing consumed: withdrawal still active, balance untouched.
        assertEq(treasury.activeWithdrawalId(), id, "withdrawal slot must survive");
        (,, uint256 amt,) = treasury.pendingWithdrawal();
        assertEq(amt, 5e18);
        assertEq(treasury.creatorWithdrawable(address(sgov)), 10e18, "balance not decremented");

        // Transfers resume -> the SAME withdrawal executes.
        sgov.setPaused(false);
        vm.prank(creator);
        treasury.executeWithdrawal(id);
        assertEq(treasury.creatorWithdrawable(address(sgov)), 5e18);
        assertEq(sgov.balanceOf(creator), 100e18 - 10e18 + 5e18);
        assertEq(treasury.activeWithdrawalId(), 0);
    }

    // ===================================================================== //
    //  THE KEY ONE: reclaim of an expired deposit during a pause           //
    //  must NOT consume the queue entry, and must succeed later.            //
    // ===================================================================== //

    function test_reclaimExpired_pausedAtExpiry_doesNotStrandFunds() public {
        uint256 before = sgov.balanceOf(alice);
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(sgov), 20e18, DISCLOSURE);
        assertEq(sgov.balanceOf(alice), before - 20e18, "escrowed");

        // The 7-day window passes while the token is paused.
        vm.warp(block.timestamp + treasury.ACCEPT_WINDOW() + 1);
        sgov.setPaused(true);

        // Reclaim reverts on the refund transfer — atomically.
        vm.prank(bob);
        vm.expectRevert(MockStockToken.TransfersPaused.selector);
        treasury.reclaimExpired(id);

        // CRITICAL: the entry is NOT consumed — still Pending, funds still escrowed.
        (, address asset, uint256 amount,, ProjectTreasury.PendingStatus status,) = treasury.pendingDeposits(id);
        assertEq(uint8(status), uint8(ProjectTreasury.PendingStatus.Pending), "entry must stay Pending");
        assertEq(asset, address(sgov));
        assertEq(amount, 20e18);

        // Transfers resume -> reclaim succeeds, depositor made whole.
        sgov.setPaused(false);
        vm.prank(alice);
        treasury.reclaimExpired(id);
        assertEq(sgov.balanceOf(alice), before, "depositor fully refunded once unpaused");

        (,,,, ProjectTreasury.PendingStatus statusAfter,) = treasury.pendingDeposits(id);
        assertEq(uint8(statusAfter), uint8(ProjectTreasury.PendingStatus.Reclaimed));
    }

    function test_declineDeposit_paused_isReCallable() public {
        uint256 before = sgov.balanceOf(alice);
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(sgov), 20e18, DISCLOSURE);

        sgov.setPaused(true);
        vm.prank(creator);
        vm.expectRevert(MockStockToken.TransfersPaused.selector);
        treasury.declineDeposit(id);

        // Entry preserved.
        (,,,, ProjectTreasury.PendingStatus status,) = treasury.pendingDeposits(id);
        assertEq(uint8(status), uint8(ProjectTreasury.PendingStatus.Pending));

        sgov.setPaused(false);
        vm.prank(creator);
        treasury.declineDeposit(id);
        assertEq(sgov.balanceOf(alice), before);
    }

    // ===================================================================== //
    //  Accept works WHILE paused — it moves no tokens                       //
    // ===================================================================== //

    function test_acceptDeposit_worksWhilePaused() public {
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(sgov), 20e18, DISCLOSURE);

        sgov.setPaused(true); // funds already escrowed; acceptance is pure accounting
        vm.prank(creator);
        treasury.acceptDeposit(id);

        assertEq(treasury.lockedBalance(address(sgov)), 20e18);
    }

    // ===================================================================== //
    //  isBlocked deny-list surfaces as a revert on deposit paths            //
    // ===================================================================== //

    function test_blockedTreasury_blocksCreatorDeposit() public {
        sgov.setBlocked(address(treasury), true); // issuer blocks the treasury address
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.AddressBlocked.selector, address(treasury)));
        treasury.deposit(address(sgov), 10e18);
    }

    function test_blockedDepositor_blocksProposal() public {
        sgov.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.AddressBlocked.selector, alice));
        treasury.proposeDeposit(address(sgov), 20e18, DISCLOSURE);
    }

    function test_blockedTreasury_blocksWithdrawalButStaysReCallable() public {
        vm.prank(creator);
        treasury.deposit(address(sgov), 10e18);
        vm.prank(creator);
        uint256 id = treasury.announceWithdrawal(address(sgov), 10e18);
        vm.warp(block.timestamp + NOTICE);

        sgov.setBlocked(address(treasury), true);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.AddressBlocked.selector, address(treasury)));
        treasury.executeWithdrawal(id);

        // Slot intact.
        assertEq(treasury.activeWithdrawalId(), id);

        sgov.setBlocked(address(treasury), false);
        vm.prank(creator);
        treasury.executeWithdrawal(id);
        assertEq(treasury.creatorWithdrawable(address(sgov)), 0);
    }
}
