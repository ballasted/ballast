// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MetadataDenylist} from "../src/MetadataDenylist.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

// Adversarial tests first (CLAUDE.md): the whole value of a takedown control is that
// ONLY the owner can operate it and that every action leaves a truthful record.
contract MetadataDenylistTest is Test {
    MetadataDenylist dl;
    address owner = makeAddr("owner");
    address safe = makeAddr("safe");
    address attacker = makeAddr("attacker");
    address token = makeAddr("token");
    address token2 = makeAddr("token2");

    event MetadataDenied(address indexed token, bool denied, string reason, uint64 at);

    function setUp() public {
        dl = new MetadataDenylist(owner);
    }

    // ── Adversarial ────────────────────────────────────────────────────────────

    function test_setDenied_onlyOwner_reverts() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        dl.setDenied(token, true, "impersonation");
    }

    function test_setDenied_zeroAddress_reverts() public {
        vm.prank(owner);
        vm.expectRevert(MetadataDenylist.ZeroAddress.selector);
        dl.setDenied(address(0), true, "impersonation");
    }

    function test_setDenied_emptyReason_reverts() public {
        // A reason is required even when denying, so the record always says why.
        vm.prank(owner);
        vm.expectRevert(MetadataDenylist.ReasonRequired.selector);
        dl.setDenied(token, true, "");
    }

    function test_clear_alsoRequiresReason() public {
        vm.prank(owner);
        dl.setDenied(token, true, "impersonation");
        vm.prank(owner);
        vm.expectRevert(MetadataDenylist.ReasonRequired.selector);
        dl.setDenied(token, false, "");
    }

    function test_acceptOwnership_onlyPending_reverts() public {
        vm.prank(owner);
        dl.transferOwnership(safe);
        // The attacker (and anyone who is not the pending owner) cannot accept.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        dl.acceptOwnership();
    }

    function test_transfer_doesNotChangeOwnerUntilAccept() public {
        vm.prank(owner);
        dl.transferOwnership(safe);

        // Owner is unchanged until the Safe accepts.
        assertEq(dl.owner(), owner);
        assertEq(dl.pendingOwner(), safe);

        // The old owner can still act; the pending owner cannot yet.
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        dl.setDenied(token, true, "impersonation");

        vm.prank(owner);
        dl.setDenied(token, true, "impersonation");
        assertTrue(dl.isDenied(token));
    }

    // ── Two-step ownership handoff to the Safe ──────────────────────────────────

    function test_twoStepTransfer_full() public {
        vm.prank(owner);
        dl.transferOwnership(safe);
        vm.prank(safe);
        dl.acceptOwnership();

        assertEq(dl.owner(), safe);
        assertEq(dl.pendingOwner(), address(0));

        // New owner operates; old owner is locked out.
        vm.prank(safe);
        dl.setDenied(token, true, "impersonation");
        assertTrue(dl.isDenied(token));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        dl.setDenied(token2, true, "phishing");
    }

    // ── Default-allow + record correctness ──────────────────────────────────────

    function test_defaultAllow() public view {
        assertFalse(dl.isDenied(token));
        assertEq(dl.deniedCount(), 0);
        assertEq(dl.deniedTokens().length, 0);
    }

    function test_deny_recordsStateReasonAndTime() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(true, false, false, true);
        emit MetadataDenied(token, true, "impersonates Robinhood", uint64(block.timestamp));

        vm.prank(owner);
        dl.setDenied(token, true, "impersonates Robinhood");

        assertTrue(dl.isDenied(token));
        (bool denied, uint64 updatedAt, string memory reason) = dl.entryOf(token);
        assertTrue(denied);
        assertEq(updatedAt, uint64(1_800_000_000));
        assertEq(reason, "impersonates Robinhood");

        address[] memory list = dl.deniedTokens();
        assertEq(list.length, 1);
        assertEq(list[0], token);
        assertEq(dl.deniedCount(), 1);
    }

    function test_toggleOff_keepsReasonButLeavesList() public {
        vm.prank(owner);
        dl.setDenied(token, true, "impersonation");
        vm.warp(1_800_000_500);
        vm.prank(owner);
        dl.setDenied(token, false, "reinstated after review");

        assertFalse(dl.isDenied(token));
        assertEq(dl.deniedCount(), 0);
        assertEq(dl.deniedTokens().length, 0);

        // The record persists: last state, when, and why.
        (bool denied, uint64 updatedAt, string memory reason) = dl.entryOf(token);
        assertFalse(denied);
        assertEq(updatedAt, uint64(1_800_000_500));
        assertEq(reason, "reinstated after review");
    }

    function test_noDuplicateListEntry_onReDeny() public {
        vm.startPrank(owner);
        dl.setDenied(token, true, "impersonation");
        dl.setDenied(token, true, "impersonation, updated grounds");
        vm.stopPrank();

        assertEq(dl.deniedCount(), 1);
        assertEq(dl.deniedTokens().length, 1);
        (, , string memory reason) = dl.entryOf(token);
        assertEq(reason, "impersonation, updated grounds");
    }

    function test_deniedTokens_filtersToCurrentlyDenied() public {
        vm.startPrank(owner);
        dl.setDenied(token, true, "a");
        dl.setDenied(token2, true, "b");
        dl.setDenied(token, false, "cleared"); // token un-denied but still in _list
        vm.stopPrank();

        address[] memory list = dl.deniedTokens();
        assertEq(list.length, 1);
        assertEq(list[0], token2);
        assertEq(dl.deniedCount(), 1);
    }
}
