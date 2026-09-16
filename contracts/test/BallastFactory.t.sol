// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastToken} from "../src/BallastToken.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
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
    address greenAsset = makeAddr("greenAsset");

    function setUp() public {
        registry = new AssetRegistry(owner);
        // Seeder + ethUsdFeed are only exercised by graduate() (fork-tested
        // separately); dummies here keep the launch/wiring unit tests pure.
        BallastSeeder seeder = new BallastSeeder(IPoolManager(address(1)), WETH, address(2));
        address[] memory green = new address[](1);
        green[0] = greenAsset;
        factory = new BallastFactory(address(registry), WETH, seeder, address(3), 24 hours, green);
    }

    // Salt mining is gone (step c of the quote-asset workstream): a token's
    // address is now plain-CREATE, nonce-based, and genuinely unconstrained
    // relative to WETH — it can land on either side. This test used to assert
    // the mined ordering; now it only asserts launch() itself doesn't depend on
    // ordering at all (deploy succeeds regardless of which side the address
    // happens to fall on). Whether a SPECIFIC token can graduate is a separate,
    // later question — BallastSeeder still only supports token-as-currency0
    // pools until its mirrored one-sided-liquidity math ships.
    function test_launch_succeedsRegardlessOfTokenAddressOrdering() public {
        (BallastToken t,) = _launch();
        assertTrue(address(t) != address(0), "token must deploy");
        // No assertion on address(t) vs WETH — that relationship is no longer
        // guaranteed, by design.
    }

    function _launch() internal returns (BallastToken t, ProjectTreasury tr) {
        vm.prank(creator);
        (, address token, address treasury) = factory.launch("Project", "PRJ", 30 days, "ipfs://proj", WETH);
        return (BallastToken(token), ProjectTreasury(treasury));
    }

    // ── Metadata: updatable-with-history, launch identity permanent ──────────
    function test_metadata_launchSetAndReadable() public {
        (BallastToken t,) = _launch();
        assertEq(t.launchMetadataURI(), "ipfs://proj", "launch URI");
        assertEq(t.metadataURI(), "ipfs://proj", "current URI == launch at start");
        assertFalse(t.metadataChanged(), "unchanged at launch");
    }

    function test_metadata_creatorCanUpdate_andHistoryIsVisible() public {
        (BallastToken t,) = _launch();
        // Every change emits MetadataUpdated(old, new, ts) — the public log.
        vm.expectEmit(false, false, false, true, address(t));
        emit BallastToken.MetadataUpdated("ipfs://proj", "ipfs://v2", block.timestamp);
        vm.prank(creator);
        t.setMetadataURI("ipfs://v2");

        assertEq(t.metadataURI(), "ipfs://v2", "current updated");
        assertEq(t.launchMetadataURI(), "ipfs://proj", "launch identity permanent");
        assertTrue(t.metadataChanged(), "flagged as changed");
    }

    function test_metadata_onlyCreatorCanUpdate() public {
        (BallastToken t,) = _launch();
        vm.prank(alice);
        vm.expectRevert(BallastToken.OnlyCreator.selector);
        t.setMetadataURI("ipfs://hijack");
        // factory can't either — this is the creator's to change.
        vm.prank(address(factory));
        vm.expectRevert(BallastToken.OnlyCreator.selector);
        t.setMetadataURI("ipfs://hijack");
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
            factory.launch("P", "P", ok[i], "", WETH);
        }
        assertEq(factory.launchCount(), 3);

        vm.prank(creator);
        vm.expectRevert(BallastFactory.BadNoticePeriod.selector);
        factory.launch("P", "P", 5 days, "", WETH);

        vm.prank(creator);
        vm.expectRevert(BallastFactory.BadNoticePeriod.selector);
        factory.launch("P", "P", 0, "", WETH);
    }

    // ===================================================================== //
    //  Quote asset: WETH-only for now, but a real per-launch field          //
    // ===================================================================== //

    function test_quoteAsset_storedPerLaunch() public {
        vm.prank(creator);
        (, address token,) = factory.launch("P", "P", 30 days, "", WETH);
        (,,, address storedQuoteAsset) = factory.launches(factory.launchIdOf(token) - 1);
        assertEq(storedQuoteAsset, WETH);
    }

    function test_quoteAsset_nonWeth_reverts() public {
        address notWeth = makeAddr("notWeth");
        vm.prank(creator);
        vm.expectRevert(BallastFactory.QuoteAssetNotSupportedYet.selector);
        factory.launch("P", "P", 30 days, "", notWeth);
    }

    // A GREEN asset (per docs/exit-liquidity-table.md), fixed at deploy, is
    // accepted exactly like WETH — the gate is an external-liquidity check, not
    // a WETH-specific capability gap.
    function test_quoteAsset_green_accepted() public {
        vm.prank(creator);
        (, address token,) = factory.launch("P", "P", 30 days, "", greenAsset);
        (,,, address storedQuoteAsset) = factory.launches(factory.launchIdOf(token) - 1);
        assertEq(storedQuoteAsset, greenAsset);
    }

    // An asset NOT on the green list, and not WETH, still reverts — even if it's
    // a real AssetRegistry treasury asset. Promoting one is a deploy-time
    // decision (re-running the exit-liquidity table), never implicit.
    function test_quoteAsset_amberTreasuryAsset_stillReverts() public {
        MockStockToken amberAsset = new MockStockToken("Amber", "AMB", 18);
        vm.prank(creator);
        vm.expectRevert(BallastFactory.QuoteAssetNotSupportedYet.selector);
        factory.launch("P", "P", 30 days, "", address(amberAsset));
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
        (uint256 id0, address tok0, address tre0) = factory.launch("A", "A", 7 days, "", WETH);
        vm.prank(alice);
        (uint256 id1, address tok1, address tre1) = factory.launch("B", "B", 90 days, "", WETH);

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertTrue(tok0 != tok1 && tre0 != tre1);
        assertEq(factory.launchIdOf(tok1), 2); // id 1 + 1
        (address tokenAt1,, address creatorAt1, address quoteAssetAt1) = factory.launches(1);
        assertEq(tokenAt1, tok1);
        assertEq(creatorAt1, alice);
        assertEq(quoteAssetAt1, WETH);
    }
}
