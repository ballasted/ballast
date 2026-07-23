// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastToken} from "../src/BallastToken.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";

/// @dev Phase 1 factory tests. Adversarial-first: the wiring invariants (permanent
///      treasury pointer, immutable projectToken, self-backing impossible, notice
///      period locked to the offered set) are the trust core of a launch.
contract BallastFactoryTest is Test {
    AssetRegistry registry;
    BallastFactory factory;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    uint256 constant SUPPLY = 1_000_000_000e18;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function setUp() public {
        registry = new AssetRegistry(owner);
        factory = new BallastFactory(address(registry), WETH);
    }

    function test_tokenMinedBelowWeth_currency0() public {
        (BallastToken t,) = _launch();
        assertLt(uint160(address(t)), uint160(WETH), "token must sort below WETH (currency0)");
    }

    function _launch() internal returns (BallastToken t, ProjectTreasury tr) {
        vm.prank(creator);
        (, address token, address treasury) = factory.launch("Project", "PRJ", 30 days);
        return (BallastToken(token), ProjectTreasury(treasury));
    }

    function test_launch_wiresEverythingAtomically() public {
        (BallastToken t, ProjectTreasury tr) = _launch();

        // token side
        assertEq(t.totalSupply(), SUPPLY, "fixed supply");
        assertEq(t.treasury(), address(tr), "token -> treasury pointer set");
        assertEq(t.factory(), address(factory));
        assertEq(t.creator(), creator);
        assertEq(t.balanceOf(address(factory)), SUPPLY, "supply held by factory (curve routing next phase)");

        // treasury side
        assertEq(tr.projectToken(), address(t), "treasury -> token (immutable)");
        assertEq(tr.creator(), creator);
        assertEq(tr.noticePeriod(), 30 days);
        assertEq(address(tr.registry()), address(registry));

        // registry
        assertEq(factory.launchCount(), 1);
        assertEq(factory.launchIdOf(address(t)), 1); // id 0 + 1
    }

    // ===================================================================== //
    //  Mint authority renounced — supply is permanently fixed               //
    // ===================================================================== //

    function test_noMintFunction_supplyFixed() public {
        (BallastToken t,) = _launch();
        // There is no mint function on BallastToken at all (compile-time guarantee);
        // supply can only be what the constructor minted.
        assertEq(t.totalSupply(), SUPPLY);
        // burns aren't exposed either; the value is immovable except by transfer.
    }

    // ===================================================================== //
    //  Treasury pointer is write-once and permanent                         //
    // ===================================================================== //

    function test_initTreasury_cannotBeRecalled_byFactoryOrAnyone() public {
        (BallastToken t, ProjectTreasury tr) = _launch();

        // Already set during launch -> factory re-call reverts.
        vm.prank(address(factory));
        vm.expectRevert(BallastToken.TreasuryAlreadySet.selector);
        t.initTreasury(address(0xBEEF));

        // A non-factory caller can never set it.
        vm.prank(alice);
        vm.expectRevert(BallastToken.OnlyFactory.selector);
        t.initTreasury(address(0xBEEF));

        assertEq(t.treasury(), address(tr), "pointer unchanged");
    }

    // ===================================================================== //
    //  Self-backing impossible on the launched pair                         //
    // ===================================================================== //

    function test_selfBacking_impossibleOnLaunchedPair() public {
        (BallastToken t, ProjectTreasury tr) = _launch();
        // creator holds no project token here, but the guard triggers before balance
        vm.prank(creator);
        vm.expectRevert(ProjectTreasury.SelfBacking.selector);
        tr.deposit(address(t), 1e18);
    }

    // ===================================================================== //
    //  Notice period restricted to the offered set                          //
    // ===================================================================== //

    function test_noticePeriod_onlyOfferedValues() public {
        uint256[3] memory ok = [uint256(7 days), 30 days, 90 days];
        for (uint256 i = 0; i < ok.length; i++) {
            vm.prank(creator);
            factory.launch("P", "P", ok[i]);
        }
        assertEq(factory.launchCount(), 3);

        vm.prank(creator);
        vm.expectRevert(BallastFactory.BadNoticePeriod.selector);
        factory.launch("P", "P", 5 days);

        vm.prank(creator);
        vm.expectRevert(BallastFactory.BadNoticePeriod.selector);
        factory.launch("P", "P", 0);
    }

    // ===================================================================== //
    //  Launched treasury actually uses the factory's registry               //
    // ===================================================================== //

    function test_launchedTreasury_usesFactoryRegistry_forDeposits() public {
        (BallastToken t, ProjectTreasury tr) = _launch();

        MockStockToken sgov = new MockStockToken("SGOV", "SGOV", 18);
        vm.prank(owner);
        registry.setAsset(address(sgov), address(0xFEED), 3 days, 1e15, MarketHours.UsEquities24_5);

        sgov.mint(creator, 100e18);
        vm.startPrank(creator);
        sgov.approve(address(tr), type(uint256).max);
        tr.deposit(address(sgov), 10e18);
        vm.stopPrank();

        assertEq(tr.creatorWithdrawable(address(sgov)), 10e18);
        // sanity: the project token can never be an allowed asset (no feed) -> stays blocked
        assertFalse(registry.isAllowed(address(t)));
    }

    // ===================================================================== //
    //  Distinct launches                                                    //
    // ===================================================================== //

    function test_twoLaunches_distinctAddressesAndIds() public {
        vm.prank(creator);
        (uint256 id0, address tok0, address tre0) = factory.launch("A", "A", 7 days);
        vm.prank(alice);
        (uint256 id1, address tok1, address tre1) = factory.launch("B", "B", 90 days);

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertTrue(tok0 != tok1 && tre0 != tre1);
        assertEq(factory.launchIdOf(tok1), 2); // id 1 + 1
        (address tokenAt1,, address creatorAt1) = factory.launches(1);
        assertEq(tokenAt1, tok1);
        assertEq(creatorAt1, alice);
    }
}
