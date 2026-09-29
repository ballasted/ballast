// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "openzeppelin-contracts/contracts/governance/TimelockController.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {FeeConfig} from "../src/FeeConfig.sol";

/// @notice Fork-independent (pure unit) proof of the TimelockController setup
/// `contracts/script/DeployTimelock.s.sol` deploys: 7-day delay, the Safe as
/// BOTH proposer and executor, admin renounced at deploy (self-administering).
/// Also proves the follow-on step — transferring an owned contract's
/// ownership to the timelock, then accepting it ONLY through a scheduled +
/// executed timelock operation, never instantly.
contract DeployTimelockTest is Test {
    address safe = makeAddr("safe");
    address deployer = makeAddr("deployer");
    uint256 constant MIN_DELAY = 7 days;

    TimelockController timelock;

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;
        // admin = address(0): OZ's own recommended self-administering pattern
        // (matches DeployTimelock.s.sol exactly).
        timelock = new TimelockController(MIN_DELAY, proposers, executors, address(0));
    }

    function test_roles_setUpExactlyAsIntended() public view {
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), safe), "Safe must be proposer");
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), safe), "Safe must be executor");
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), safe), "OZ grants proposers canceller too");
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer), "deployer must hold NO admin role");
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(0)), "the zero address holds nothing");
        assertTrue(
            timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)),
            "the timelock must self-administer (admin=address(0) constructor pattern)"
        );
        assertEq(timelock.getMinDelay(), MIN_DELAY);
    }

    /// @notice No key outside the timelock's own delayed process can ever grant
    /// or revoke proposer/executor — not the deployer, not the Safe directly,
    /// only a scheduled+executed operation through the timelock itself.
    function test_noExternalKeyCanGrantRoles() public {
        // Resolve the role hash FIRST, on its own line -- `vm.prank`/
        // `vm.expectRevert` only apply to the very next external call, and
        // `timelock.PROPOSER_ROLE()` inline would itself consume both,
        // leaving `grantRole` to run unpranked/unchecked.
        bytes32 proposerRole = timelock.PROPOSER_ROLE();

        vm.prank(deployer);
        vm.expectRevert();
        timelock.grantRole(proposerRole, deployer);

        vm.prank(safe);
        vm.expectRevert();
        timelock.grantRole(proposerRole, deployer);
    }

    /// @notice End-to-end: transferOwnership(timelock) from the current owner,
    /// then acceptOwnership() can ONLY happen via schedule() + wait 7 days +
    /// execute() — never instantly, and never by anyone but the Safe
    /// (proposer) initiating it.
    function test_acceptOwnership_mustGoThroughScheduleAndDelay() public {
        FeeConfig fc = new FeeConfig(deployer, makeAddr("vault"));
        vm.prank(deployer);
        fc.transferOwnership(address(timelock));
        assertEq(fc.pendingOwner(), address(timelock));

        bytes memory acceptCalldata = abi.encodeWithSignature("acceptOwnership()");

        // Cannot execute before scheduling.
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(fc), 0, acceptCalldata, bytes32(0), bytes32(0));

        // Schedule (proposer-only).
        vm.prank(safe);
        timelock.schedule(address(fc), 0, acceptCalldata, bytes32(0), bytes32(0), MIN_DELAY);

        // Cannot execute immediately -- must wait the full delay.
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(fc), 0, acceptCalldata, bytes32(0), bytes32(0));

        // Still not ready one second before the delay elapses.
        vm.warp(block.timestamp + MIN_DELAY - 1);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(fc), 0, acceptCalldata, bytes32(0), bytes32(0));

        // Ready once the full delay has elapsed.
        vm.warp(block.timestamp + 1);
        vm.prank(safe);
        timelock.execute(address(fc), 0, acceptCalldata, bytes32(0), bytes32(0));

        assertEq(fc.owner(), address(timelock), "ownership only actually moves after the real delay");
    }

    function test_nonProposer_cannotSchedule() public {
        AssetRegistry reg = new AssetRegistry(deployer);
        vm.prank(deployer);
        reg.transferOwnership(address(timelock));

        bytes memory acceptCalldata = abi.encodeWithSignature("acceptOwnership()");
        vm.prank(deployer); // not the Safe
        vm.expectRevert();
        timelock.schedule(address(reg), 0, acceptCalldata, bytes32(0), bytes32(0), MIN_DELAY);
    }
}
