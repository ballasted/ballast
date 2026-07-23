// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

contract FeeConfigTest is Test {
    FeeConfig cfg;
    address owner = makeAddr("owner");
    address vault = makeAddr("vault");
    address ref = makeAddr("ref");
    address alice = makeAddr("alice");

    function setUp() public {
        cfg = new FeeConfig(owner, vault);
    }

    function test_defaults() public view {
        assertEq(cfg.feeBps(), 100); // 1%
        assertEq(cfg.creatorBps(), 5000);
        assertEq(cfg.platformBps(), 3500);
        assertEq(cfg.referrerBps(), 1500);
        assertEq(cfg.platformVault(), vault);
        assertEq(uint256(cfg.creatorBps()) + cfg.platformBps() + cfg.referrerBps(), cfg.BPS());
    }

    function test_setParams_valid() public {
        vm.prank(owner);
        cfg.setParams(50, 6000, 3000, 1000);
        assertEq(cfg.feeBps(), 50);
        assertEq(cfg.creatorBps(), 6000);
    }

    function test_setParams_badSplit_reverts() public {
        vm.prank(owner);
        vm.expectRevert(FeeConfig.BadSplit.selector);
        cfg.setParams(100, 5000, 3000, 1500); // sums 9500 != 10000
    }

    function test_setParams_feeCap_reverts() public {
        vm.prank(owner);
        vm.expectRevert(FeeConfig.BadFee.selector);
        cfg.setParams(1001, 5000, 3500, 1500); // > 10%
        vm.prank(owner);
        vm.expectRevert(FeeConfig.BadFee.selector);
        cfg.setParams(0, 5000, 3500, 1500); // zero fee
    }

    function test_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cfg.setParams(100, 5000, 3500, 1500);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cfg.setReferrer(ref, true);
    }

    function test_referrerAllowlist_gatesEffectiveReferrer() public {
        // unregistered -> rolls to platform (address(0))
        assertEq(cfg.effectiveReferrer(ref), address(0));

        vm.prank(owner);
        cfg.setReferrer(ref, true);
        assertEq(cfg.effectiveReferrer(ref), ref);

        vm.prank(owner);
        cfg.setReferrer(ref, false);
        assertEq(cfg.effectiveReferrer(ref), address(0));
    }

    function test_setPlatformVault() public {
        address v2 = makeAddr("v2");
        vm.prank(owner);
        cfg.setPlatformVault(v2);
        assertEq(cfg.platformVault(), v2);

        vm.prank(owner);
        vm.expectRevert(FeeConfig.ZeroAddress.selector);
        cfg.setPlatformVault(address(0));
    }
}
