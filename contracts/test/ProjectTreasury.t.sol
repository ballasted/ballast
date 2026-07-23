// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";

/// @dev Adversarial-first test suite. The attack surface is the product, so the
///      abuse cases come before the happy path. Each hard invariant from
///      CLAUDE.md / the build spec has at least one test that would fail loudly if
///      the invariant were ever weakened.
///
/// ⚠️ SCOPE — READ THIS. This suite runs against `MockERC20`, a vanilla ERC-20. It
///    proves the treasury's accounting and access-control LOGIC only.
///
///    Contract custody of a real Robinhood Stock Token is CONFIRMED: the Session 0
///    probe (script/ProbeStockTokenCustody.s.sol) ran a live mainnet broadcast
///    against SGOV on 2026-07-23 and returned VERDICT: YES (push, pull, hold,
///    sweep all succeeded, EOA balance restored).
///
///    NOT modeled here: the stock token gates every transfer through an
///    AccessControlsRegistry (`paused()` + `isBlocked(from)`/`isBlocked(to)`
///    deny-list). Contracts are permitted by default, but a blocked address would
///    revert. Add a mock that models this gate before relying on these tests for
///    production behavior.
contract ProjectTreasuryTest is Test {
    AssetRegistry registry;
    ProjectTreasury treasury;

    MockERC20 projectToken; // the launch's own token (never depositable)
    MockERC20 nvda; // an allowlisted "stock token" (18 decimals)
    MockERC20 usdg; // a second allowlisted asset

    address owner = makeAddr("owner"); // registry owner (platform)
    address creator = makeAddr("creator");
    address alice = makeAddr("alice"); // third-party depositor
    address bob = makeAddr("bob");

    uint256 constant NOTICE = 30 days;
    uint256 constant MIN_DEP = 1e18;
    bytes32 constant DISCLOSURE = keccak256("v1: no claim, ever");

    function setUp() public {
        registry = new AssetRegistry(owner);

        projectToken = new MockERC20("Project", "PRJ", 18);
        nvda = new MockERC20("NVDA Stock Token", "NVDA", 18);
        usdg = new MockERC20("USDG", "USDG", 18);

        vm.startPrank(owner);
        registry.setAsset(address(nvda), address(0xFEED1), 1 hours, MIN_DEP);
        registry.setAsset(address(usdg), address(0xFEED2), 1 days, MIN_DEP);
        vm.stopPrank();

        treasury = new ProjectTreasury(address(projectToken), creator, NOTICE, address(registry));

        // Fund actors and pre-approve the treasury.
        nvda.mint(creator, 1_000e18);
        nvda.mint(alice, 1_000e18);
        usdg.mint(creator, 1_000e18);
        usdg.mint(alice, 1_000e18);

        vm.prank(creator);
        nvda.approve(address(treasury), type(uint256).max);
        vm.prank(creator);
        usdg.approve(address(treasury), type(uint256).max);
        vm.prank(alice);
        nvda.approve(address(treasury), type(uint256).max);
        vm.prank(alice);
        usdg.approve(address(treasury), type(uint256).max);
    }

    // ===================================================================== //
    //  Invariant 1: notice period is immutable                             //
    // ===================================================================== //

    function test_noticePeriod_isImmutable() public view {
        assertEq(treasury.noticePeriod(), NOTICE);
    }

    function test_noticePeriod_survivesActivity() public {
        // No code path can change it. Run a full lifecycle and re-check.
        vm.prank(creator);
        treasury.deposit(address(nvda), 10e18);
        vm.prank(creator);
        uint256 id = treasury.announceWithdrawal(address(nvda), 5e18);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(creator);
        treasury.executeWithdrawal(id);
        assertEq(treasury.noticePeriod(), NOTICE, "notice period must never move");
    }

    function testFuzz_constructor_rejectsZeroNotice(address tok, address c, address reg) public {
        vm.assume(tok != address(0) && c != address(0) && reg != address(0));
        vm.expectRevert(bytes("noticePeriod=0"));
        new ProjectTreasury(tok, c, 0, reg);
    }

    // ===================================================================== //
    //  Invariant: self-backing is impossible                               //
    // ===================================================================== //

    function test_deposit_projectToken_reverts() public {
        projectToken.mint(creator, 100e18);
        vm.prank(creator);
        projectToken.approve(address(treasury), type(uint256).max);

        vm.prank(creator);
        vm.expectRevert(ProjectTreasury.SelfBacking.selector);
        treasury.deposit(address(projectToken), 10e18);
    }

    function test_proposeDeposit_projectToken_reverts() public {
        projectToken.mint(alice, 100e18);
        vm.prank(alice);
        projectToken.approve(address(treasury), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(ProjectTreasury.SelfBacking.selector);
        treasury.proposeDeposit(address(projectToken), 10e18, DISCLOSURE);
    }

    // ===================================================================== //
    //  Invariant: third-party deposits are PERMANENTLY locked              //
    // ===================================================================== //

    function test_thirdPartyDeposit_isNotWithdrawableByCreator() public {
        // Alice proposes, creator accepts -> funds are locked forever.
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);
        vm.prank(creator);
        treasury.acceptDeposit(id);

        assertEq(treasury.lockedBalance(address(nvda)), 100e18);
        assertEq(treasury.creatorWithdrawable(address(nvda)), 0);

        // Creator cannot announce a withdrawal against locked funds — there is
        // nothing withdrawable.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProjectTreasury.ExceedsWithdrawable.selector, 1, 0));
        treasury.announceWithdrawal(address(nvda), 1);
    }

    function test_lockedFunds_cannotBeDrainedEvenAlongsideCreatorDeposits() public {
        // Creator deposits 40, Alice locks 100. Only 40 may ever leave.
        vm.prank(creator);
        treasury.deposit(address(nvda), 40e18);

        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);
        vm.prank(creator);
        treasury.acceptDeposit(id);

        assertEq(treasury.heldBalance(address(nvda)), 140e18);

        // Announce more than withdrawable (trying to reach into locked funds).
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProjectTreasury.ExceedsWithdrawable.selector, 41e18, 40e18));
        treasury.announceWithdrawal(address(nvda), 41e18);

        // The maximum the creator can pull is exactly their own 40.
        vm.prank(creator);
        uint256 wid = treasury.announceWithdrawal(address(nvda), 40e18);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(creator);
        treasury.executeWithdrawal(wid);

        // 100 locked remains, untouchable.
        assertEq(treasury.lockedBalance(address(nvda)), 100e18);
        assertEq(treasury.creatorWithdrawable(address(nvda)), 0);
        assertEq(nvda.balanceOf(address(treasury)), 100e18);
    }

    // ===================================================================== //
    //  Deposit queue: expiry, decline, accept-window                       //
    // ===================================================================== //

    function test_reclaimExpired_returnsFundsAfterWindow() public {
        uint256 before = nvda.balanceOf(alice);
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);
        assertEq(nvda.balanceOf(alice), before - 100e18);

        // Cannot reclaim while the window is open.
        vm.expectRevert(ProjectTreasury.WindowOpen.selector);
        treasury.reclaimExpired(id);

        vm.warp(block.timestamp + treasury.ACCEPT_WINDOW() + 1);
        // Anyone may trigger it (permissionless).
        vm.prank(bob);
        treasury.reclaimExpired(id);

        assertEq(nvda.balanceOf(alice), before, "escrow must return in full");
        assertEq(treasury.lockedBalance(address(nvda)), 0);
    }

    function test_acceptAfterWindow_reverts() public {
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);

        vm.warp(block.timestamp + treasury.ACCEPT_WINDOW() + 1);
        vm.prank(creator);
        vm.expectRevert(ProjectTreasury.WindowClosed.selector);
        treasury.acceptDeposit(id);
    }

    function test_declineDeposit_returnsFunds() public {
        uint256 before = nvda.balanceOf(alice);
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);

        vm.prank(creator);
        treasury.declineDeposit(id);
        assertEq(nvda.balanceOf(alice), before);
    }

    function test_pendingEscrow_doesNotCountAsBacking() public {
        vm.prank(alice);
        treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);
        // Held (backing-eligible) balance stays zero until acceptance.
        assertEq(treasury.heldBalance(address(nvda)), 0);
        assertEq(nvda.balanceOf(address(treasury)), 100e18); // escrow present
    }

    function test_doubleResolve_reverts() public {
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);
        vm.prank(creator);
        treasury.acceptDeposit(id);

        vm.prank(creator);
        vm.expectRevert(ProjectTreasury.BadState.selector);
        treasury.declineDeposit(id);

        vm.prank(creator);
        vm.expectRevert(ProjectTreasury.BadState.selector);
        treasury.acceptDeposit(id);
    }

    function test_proposeDeposit_requiresDisclosure() public {
        vm.prank(alice);
        vm.expectRevert(ProjectTreasury.DisclosureRequired.selector);
        treasury.proposeDeposit(address(nvda), 100e18, bytes32(0));
    }

    function test_disclosureVersion_isRecorded() public {
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);
        (,,,,, bytes32 stored) = treasury.pendingDeposits(id);
        assertEq(stored, DISCLOSURE);
    }

    // ===================================================================== //
    //  Withdrawal caps and two-phase timing                                //
    // ===================================================================== //

    function test_onlyOneActiveWithdrawal() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);

        vm.prank(creator);
        treasury.announceWithdrawal(address(nvda), 10e18);

        vm.prank(creator);
        vm.expectRevert(ProjectTreasury.WithdrawalPending.selector);
        treasury.announceWithdrawal(address(nvda), 10e18);
    }

    function test_cannotAnnounceMoreThanWithdrawable() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProjectTreasury.ExceedsWithdrawable.selector, 101e18, 100e18));
        treasury.announceWithdrawal(address(nvda), 101e18);
    }

    function test_cannotExecuteBeforeUnlock() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);
        vm.prank(creator);
        uint256 id = treasury.announceWithdrawal(address(nvda), 50e18);

        vm.warp(block.timestamp + NOTICE - 1);
        vm.prank(creator);
        vm.expectRevert();
        treasury.executeWithdrawal(id);

        vm.warp(block.timestamp + 1); // exactly unlockAt
        vm.prank(creator);
        treasury.executeWithdrawal(id);
        assertEq(treasury.creatorWithdrawable(address(nvda)), 50e18);
    }

    function test_cancelFreesTheSlot() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);
        vm.prank(creator);
        uint256 id = treasury.announceWithdrawal(address(nvda), 50e18);

        vm.prank(creator);
        treasury.cancelWithdrawal(id);
        assertEq(treasury.activeWithdrawalId(), 0);

        // A new one can now be announced.
        vm.prank(creator);
        treasury.announceWithdrawal(address(nvda), 50e18);
    }

    function test_pendingWithdrawal_isPubliclyReadable() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);
        vm.prank(creator);
        uint256 id = treasury.announceWithdrawal(address(nvda), 50e18);

        (uint256 pid, address asset, uint256 amount, uint64 unlockAt) = treasury.pendingWithdrawal();
        assertEq(pid, id);
        assertEq(asset, address(nvda));
        assertEq(amount, 50e18);
        assertEq(unlockAt, uint64(block.timestamp + NOTICE));
    }

    function test_executeThenAnnounceAgain_accountsCorrectly() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);

        vm.prank(creator);
        uint256 id1 = treasury.announceWithdrawal(address(nvda), 60e18);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(creator);
        treasury.executeWithdrawal(id1);
        assertEq(treasury.creatorWithdrawable(address(nvda)), 40e18);

        // Cannot now announce more than the remaining 40.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProjectTreasury.ExceedsWithdrawable.selector, 41e18, 40e18));
        treasury.announceWithdrawal(address(nvda), 41e18);
    }

    // ===================================================================== //
    //  Access control                                                      //
    // ===================================================================== //

    function test_onlyCreator_deposit() public {
        vm.prank(alice);
        vm.expectRevert(ProjectTreasury.NotCreator.selector);
        treasury.deposit(address(nvda), 10e18);
    }

    function test_onlyCreator_acceptDeposit() public {
        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(nvda), 100e18, DISCLOSURE);
        vm.prank(bob);
        vm.expectRevert(ProjectTreasury.NotCreator.selector);
        treasury.acceptDeposit(id);
    }

    function test_onlyCreator_withdrawalLifecycle() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);

        vm.prank(alice);
        vm.expectRevert(ProjectTreasury.NotCreator.selector);
        treasury.announceWithdrawal(address(nvda), 10e18);
    }

    // ===================================================================== //
    //  Asset validation                                                    //
    // ===================================================================== //

    function test_nonAllowlistedAsset_reverts() public {
        MockERC20 impostor = new MockERC20("NVDA", "NVDA", 18); // same ticker, wrong address
        impostor.mint(creator, 100e18);
        vm.prank(creator);
        impostor.approve(address(treasury), type(uint256).max);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProjectTreasury.AssetNotAllowed.selector, address(impostor)));
        treasury.deposit(address(impostor), 10e18);
    }

    function test_belowMinimum_reverts() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProjectTreasury.BelowMinimum.selector, MIN_DEP - 1, MIN_DEP));
        treasury.deposit(address(nvda), MIN_DEP - 1);
    }

    function test_zeroAmount_reverts() public {
        vm.prank(creator);
        vm.expectRevert(ProjectTreasury.ZeroAmount.selector);
        treasury.deposit(address(nvda), 0);
    }

    function test_deallistedAssetStillWithdrawable() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 100e18);

        // Platform removes the asset from the allowlist afterwards.
        vm.prank(owner);
        registry.removeAsset(address(nvda));

        // Creator can still withdraw what they already deposited.
        vm.prank(creator);
        uint256 id = treasury.announceWithdrawal(address(nvda), 100e18);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(creator);
        treasury.executeWithdrawal(id);
        assertEq(nvda.balanceOf(address(treasury)), 0);
    }

    // ===================================================================== //
    //  Accounting integrity across multiple assets & depositors            //
    // ===================================================================== //

    function test_multiAsset_multiDepositor_accounting() public {
        vm.prank(creator);
        treasury.deposit(address(nvda), 50e18);
        vm.prank(creator);
        treasury.deposit(address(usdg), 25e18);

        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(usdg), 200e18, DISCLOSURE);
        vm.prank(creator);
        treasury.acceptDeposit(id);

        assertEq(treasury.creatorWithdrawable(address(nvda)), 50e18);
        assertEq(treasury.creatorWithdrawable(address(usdg)), 25e18);
        assertEq(treasury.lockedBalance(address(usdg)), 200e18);
        assertEq(treasury.heldBalance(address(usdg)), 225e18);

        assertEq(treasury.deposited(creator, address(nvda)), 50e18);
        assertEq(treasury.deposited(alice, address(usdg)), 200e18);

        address[] memory list = treasury.assets();
        assertEq(list.length, 2);
    }

    // ===================================================================== //
    //  Reentrancy                                                          //
    // ===================================================================== //

    function test_reentrancy_onReclaim_isBlocked() public {
        ReentrantERC20 evil = new ReentrantERC20();
        vm.prank(owner);
        registry.setAsset(address(evil), address(0xFEED9), 1 hours, MIN_DEP);

        evil.mint(alice, 100e18);
        vm.prank(alice);
        evil.approve(address(treasury), type(uint256).max);

        vm.prank(alice);
        uint256 id = treasury.proposeDeposit(address(evil), 100e18, DISCLOSURE);

        // Arm the token to reenter reclaimExpired during the refund transfer.
        evil.arm(address(treasury), abi.encodeWithSelector(ProjectTreasury.reclaimExpired.selector, id));

        vm.warp(block.timestamp + treasury.ACCEPT_WINDOW() + 1);
        vm.expectRevert(); // ReentrancyGuard blocks the nested call
        treasury.reclaimExpired(id);
    }
}
