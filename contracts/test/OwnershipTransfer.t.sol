// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/// @dev PART A2 gate: before mainnet, prove that the two owner-controlled globals
///      (AssetRegistry allowlist + FeeConfig economics) can be handed from the
///      deployer EOA to a multisig, that the NEW owner can call every owner-only
///      function, and that the OLD owner is fully stripped. Also documents the one
///      stranded-capability risk (renounceOwnership permanently bricks admin).
contract OwnershipTransferTest is Test {
    AssetRegistry registry;
    FeeConfig cfg;

    address deployer = makeAddr("deployer"); // the EOA that runs the deploy script
    address multisig = makeAddr("multisig"); // the Safe ownership moves to
    address vault = makeAddr("vault");
    address asset = makeAddr("asset");
    address feed = makeAddr("feed");

    function setUp() public {
        registry = new AssetRegistry(deployer);
        cfg = new FeeConfig(deployer, vault);
        assertEq(registry.owner(), deployer);
        assertEq(cfg.owner(), deployer);
    }

    function test_transfer_newOwnerCanCallEveryOwnerOnlyFn() public {
        // Two-step hand-off to the multisig: propose, then the multisig accepts.
        vm.prank(deployer);
        registry.transferOwnership(multisig);
        vm.prank(deployer);
        cfg.transferOwnership(multisig);
        assertEq(registry.pendingOwner(), multisig, "registry pending not set");
        assertEq(cfg.pendingOwner(), multisig, "feeconfig pending not set");

        vm.prank(multisig);
        registry.acceptOwnership();
        vm.prank(multisig);
        cfg.acceptOwnership();

        assertEq(registry.owner(), multisig, "registry owner not moved");
        assertEq(cfg.owner(), multisig, "feeconfig owner not moved");

        // ---- AssetRegistry: every owner-only entrypoint, as the multisig ----
        vm.startPrank(multisig);
        registry.setAsset(asset, feed, 3 days, 1); // 4-arg overload
        registry.setAsset(asset, feed, 3 days, 1, MarketHours.UsEquities24_5); // 5-arg overload
        assertTrue(registry.isAllowed(asset));
        registry.removeAsset(asset);
        assertFalse(registry.isAllowed(asset));
        vm.stopPrank();

        // ---- FeeConfig: every owner-only entrypoint, as the multisig ----
        vm.startPrank(multisig);
        cfg.setParams(100, 5000, 3500, 1500); // 1% fee, split sums to 100%
        cfg.setPlatformVault(makeAddr("newVault"));
        cfg.setReferrer(makeAddr("ref"), true);
        vm.stopPrank();

        (uint16 feeBps, uint16 creatorBps, uint16 platformBps, uint16 referrerBps,) = cfg.feeParams();
        assertEq(feeBps, 100);
        assertEq(creatorBps, 5000);
        assertEq(platformBps, 3500);
        assertEq(referrerBps, 1500);
    }

    /// Ownable2Step anti-footgun: a proposed-but-unaccepted transfer does NOT move
    /// control, so a typo'd new owner can never strand the contracts.
    function test_pendingTransfer_doesNotStripUntilAccepted() public {
        address typo = makeAddr("typo");
        vm.prank(deployer);
        registry.transferOwnership(typo);
        // Ownership has NOT moved — deployer still controls it.
        assertEq(registry.owner(), deployer);
        vm.prank(deployer);
        registry.setAsset(asset, feed, 3 days, 1); // still works
        // And the deployer can redirect the pending transfer to the right address.
        vm.prank(deployer);
        registry.transferOwnership(multisig);
        assertEq(registry.pendingOwner(), multisig);
    }

    function test_oldOwnerFullyStripped() public {
        vm.startPrank(deployer);
        registry.transferOwnership(multisig);
        cfg.transferOwnership(multisig);
        vm.stopPrank();
        vm.prank(multisig);
        registry.acceptOwnership();
        vm.prank(multisig);
        cfg.acceptOwnership();

        // Deployer can no longer touch anything owner-gated.
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer);

        vm.prank(deployer);
        vm.expectRevert(notOwner);
        registry.setAsset(asset, feed, 3 days, 1);

        vm.prank(deployer);
        vm.expectRevert(notOwner);
        registry.removeAsset(asset);

        vm.prank(deployer);
        vm.expectRevert(notOwner);
        cfg.setParams(100, 5000, 3500, 1500);

        vm.prank(deployer);
        vm.expectRevert(notOwner);
        cfg.setPlatformVault(vault);

        vm.prank(deployer);
        vm.expectRevert(notOwner);
        cfg.setReferrer(makeAddr("ref"), true);
    }

    /// @notice STRANDED-CAPABILITY FLAG. OZ Ownable exposes renounceOwnership():
    ///         if the owner ever calls it, ownerOnly functions become PERMANENTLY
    ///         uncallable — no new asset could ever be allowlisted, no fee ever
    ///         changed. This is the only way to strand admin. It is intentional OZ
    ///         behaviour, documented here so the multisig runbook forbids it.
    ///         (Also note: transfer is single-step — a typo'd new owner cannot be
    ///         undone. Consider Ownable2Step before external launches.)
    function test_renounce_permanentlyStrandsAdmin() public {
        vm.prank(deployer);
        registry.renounceOwnership();
        assertEq(registry.owner(), address(0));

        // No one can ever allowlist an asset again.
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        registry.setAsset(asset, feed, 3 days, 1);
    }
}
