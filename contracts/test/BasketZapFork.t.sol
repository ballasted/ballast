// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BasketZap} from "../src/BasketZap.sol";
import {BackingLens} from "../src/BackingLens.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TestPoolSeeder} from "./helpers/TestPoolSeeder.sol";

interface IBallastFactoryFull {
    function launch(string calldata name_, string calldata symbol_, uint256 noticePeriod, string calldata metadataURI, address[] calldata quoteAssets_)
        external
        returns (uint256 id, address token, address treasury);
}

interface IProjectTreasuryDeposit {
    function deposit(address asset, uint256 amount) external;
}

/// @notice BasketZap exercised against REAL Robinhood Chain mainnet state:
///         the real BallastFactory, the real AssetRegistry and its real
///         Chainlink feeds, a real existing launch, a freshly-created launch
///         via the real factory, and — for the end-to-end swap assertions —
///         a REAL v4 pool seeded on this fork for real, already-allowlisted
///         assets (NVDA/SGOV/AMD).
///
///         IMPORTANT — see docs/BASKET_DISCOVERY.md §2 and docs/DECISIONS.md
///         §3: an exhaustive (within this session's RPC constraints) search
///         found ZERO on-chain WETH pools for any of the 16 AssetRegistry-
///         listed assets as of 2026-10-12. Routability (a pool existing) and
///         allowlisting (AssetRegistry) are independent — NVDA/SGOV/AMD are
///         already real-allowlisted, only their POOL is missing, and
///         anyone may permissionlessly initialize a v4 pool and add
///         liquidity to it. So the end-to-end tests below seed a real pool
///         via TestPoolSeeder (test/helpers/TestPoolSeeder.sol — test-only,
///         never deployed to mainnet), funded via forge-std's `deal()`
///         cheatcode, which the existing fork suite already proves works
///         against real Robinhood stock tokens (BuybackBurnerV2Fork.t.sol,
///         BallastRouterFork.t.sol). This touches NO privileged contract —
///         AssetRegistry is never written to, and its real owner (the
///         compromised deployer) is never impersonated, not even locally.
///         The seeded pool's price is an arbitrary 1:1 in raw units; these
///         tests assert the pipeline (swap → deposit → BackingLens), never a
///         real-world dollar figure.
///
/// SKIPS unless RH_RPC_URL_PAID is set (division of labour: the human/CI runs
/// tests with the RPC).
contract BasketZapForkTest is Test {
    address constant FACTORY = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;
    address constant REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant LENS = 0x73Ac3574c8743553f41C6E25F92A145b5c0e7240;

    // Launch id 2 on the current factory — a real, non-Safe-owned, graduated
    // launch (confirmed live on-chain, docs/BASKET_DISCOVERY.md §1).
    address constant EXISTING_TOKEN = 0x10842066A3334d76CBBc206D26C670db9768A4BF;
    address constant EXISTING_CREATOR = 0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85;

    // Real, already-allowlisted assets (docs/BASKET_DISCOVERY.md §2.1) with
    // REAL live Chainlink feeds. SPY has no seeded pool (used only for the
    // pre-swap-gate test below); NVDA/SGOV/AMD get a locally-seeded pool.
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant AMD = 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC;
    address constant NOT_AN_ASSET = address(0x000000000000000000000000000000DeadBeef);

    uint24 constant TEST_FEE = 3000;
    int24 constant TEST_TICK_SPACING = 60;
    int24 constant TEST_RANGE = 20_000;

    BasketZap zap;
    TestPoolSeeder seeder;
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);

        zap = new BasketZap(FACTORY, REGISTRY, WETH, UNIVERSAL_ROUTER, PERMIT2);
        seeder = new TestPoolSeeder(IPoolManager(POOL_MANAGER));

        _seedPool(NVDA);
        _seedPool(SGOV);
        _seedPool(AMD);

        forked = true;
    }

    function _seedPool(address asset) internal {
        uint256 wethAmt = 50 ether;
        uint256 assetAmt = 1_000_000 ether;
        deal(WETH, address(seeder), wethAmt, true);
        deal(asset, address(seeder), assetAmt, true);
        seeder.seed(WETH, asset, TEST_FEE, TEST_TICK_SPACING, TEST_RANGE, wethAmt, assetAmt);
    }

    function _leg(address asset, uint16 weightBps, uint256 minOut) internal pure returns (BasketZap.Leg memory) {
        return BasketZap.Leg({asset: asset, weightBps: weightBps, fee: TEST_FEE, tickSpacing: TEST_TICK_SPACING, hooks: address(0), minOut: minOut});
    }

    function _oneLeg(address asset, uint256 minOut) internal pure returns (BasketZap.Leg[] memory legs) {
        legs = new BasketZap.Leg[](1);
        legs[0] = BasketZap.Leg({asset: asset, weightBps: 10_000, fee: 3000, tickSpacing: 60, hooks: address(0), minOut: minOut});
    }

    function _threeLegs() internal pure returns (BasketZap.Leg[] memory legs) {
        legs = new BasketZap.Leg[](3);
        legs[0] = _leg(NVDA, 4_000, 1);
        legs[1] = _leg(SGOV, 3_000, 1);
        legs[2] = _leg(AMD, 3_000, 1);
    }

    /// @dev Returns the 4-byte selector of a low-level call's revert data, or
    ///      bytes4(0) if the call succeeded or reverted with no data.
    function _revertSelector(bytes memory returndata) internal pure returns (bytes4 sel) {
        if (returndata.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(returndata, 32))
        }
    }

    // ── Deploys against real infra ───────────────────────────────────────

    function test_fork_deploysAgainstRealInfra() public view {
        if (!forked) return;
        assertEq(address(zap.factory()), FACTORY);
        assertEq(address(zap.registry()), REGISTRY);
        assertEq(zap.weth(), WETH);
        assertEq(zap.universalRouter(), UNIVERSAL_ROUTER);
        assertEq(zap.permit2(), PERMIT2);
    }

    // ── Creator resolution against the REAL factory ──────────────────────

    function test_fork_revertsForNonCreator_realExistingLaunch() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(BasketZap.NotCreator.selector);
        zap.swapBasket{value: 1 ether}(EXISTING_TOKEN, _oneLeg(SPY, 1), block.timestamp + 1 hours);
    }

    function test_fork_revertsForUnknownLaunch_realFactory() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address notALaunch = makeAddr("notALaunch");
        vm.deal(address(this), 1 ether);
        vm.expectRevert(BasketZap.UnknownLaunch.selector);
        zap.swapBasket{value: 1 ether}(notALaunch, _oneLeg(SPY, 1), block.timestamp + 1 hours);
    }

    function test_fork_revertsForUnlistedAsset_realRegistry() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.deal(EXISTING_CREATOR, 1 ether);
        vm.prank(EXISTING_CREATOR);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.AssetNotAllowed.selector, NOT_AN_ASSET));
        zap.swapBasket{value: 1 ether}(EXISTING_TOKEN, _oneLeg(NOT_AN_ASSET, 1), block.timestamp + 1 hours);
    }

    function test_fork_revertsForSelfBacking_realExistingLaunch() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // EXISTING_TOKEN itself is obviously not AssetRegistry-listed, so the
        // allowlist check would already catch it — this proves the EARLIER,
        // more specific SelfBacking check fires first, with the right asset
        // in the error.
        vm.deal(EXISTING_CREATOR, 1 ether);
        vm.prank(EXISTING_CREATOR);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.SelfBacking.selector, EXISTING_TOKEN));
        zap.swapBasket{value: 1 ether}(EXISTING_TOKEN, _oneLeg(EXISTING_TOKEN, 1), block.timestamp + 1 hours);
    }

    // ── The Chainlink freshness gate against a REAL live feed ────────────

    function test_fork_realAssetPassesFreshnessGate_failsOnlyAtSwap() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // SPY deliberately has no seeded pool — proves the gate clears on
        // real state even when the swap itself still has nowhere to route.
        vm.deal(EXISTING_CREATOR, 1 ether);
        vm.prank(EXISTING_CREATOR);
        (bool ok, bytes memory ret) = address(zap).call{value: 1 ether}(
            abi.encodeCall(BasketZap.swapBasket, (EXISTING_TOKEN, _oneLeg(SPY, 1), block.timestamp + 1 hours))
        );
        assertFalse(ok, "expected a revert -- SPY has no seeded pool in this suite");

        bytes4 sel = _revertSelector(ret);
        assertTrue(sel != BasketZap.AssetNotAllowed.selector, "should not fail the allowlist check");
        assertTrue(sel != BasketZap.StalePrice.selector, "SPY's real feed should not be stale right now");
        assertTrue(sel != BasketZap.InvalidPrice.selector, "SPY's real feed should return a valid answer");
        assertTrue(sel != BasketZap.PriceDeviationTooLarge.selector, "first-ever read has no prior price to deviate from");
        assertTrue(sel != BasketZap.WeightsMustSumToBps.selector, "single 10000bps leg always sums correctly");
        console2.log("real pre-swap gate cleared; swap itself reverted with selector:");
        console2.logBytes4(sel);
    }

    // ── End-to-end: swap -> approve/deposit -> real BackingLens readback ─

    function test_fork_basketOnFreshLaunch_readableThroughBackingLens() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address creator = makeAddr("freshLaunchCreator");
        vm.deal(creator, 10 ether);

        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        vm.prank(creator);
        (, address token, address treasury) =
            IBallastFactoryFull(FACTORY).launch("E2E Basket Test", "E2EB", 7 days, "ipfs://test", quoteAssets);

        vm.prank(creator);
        zap.swapBasket{value: 5 ether}(token, _threeLegs(), block.timestamp + 1 hours);

        assertGt(IERC20(NVDA).balanceOf(creator), 0, "creator received NVDA");
        assertGt(IERC20(SGOV).balanceOf(creator), 0, "creator received SGOV");
        assertGt(IERC20(AMD).balanceOf(creator), 0, "creator received AMD");

        _approveAndDeposit(creator, treasury, NVDA);
        _approveAndDeposit(creator, treasury, SGOV);
        _approveAndDeposit(creator, treasury, AMD);

        BackingLens.Backing memory backing = BackingLens(LENS).backingOf(treasury);
        assertEq(backing.assets.length, 3, "all three legs tracked by the treasury");
        assertGt(backing.withdrawableValueUsd, 0, "real BackingLens shows nonzero backing");
        assertGt(backing.totalValueUsd, 0);
    }

    function test_fork_basketOnExistingLaunch_readableThroughBackingLens() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.deal(EXISTING_CREATOR, 10 ether);

        // Snapshot BEFORE — EXISTING_TOKEN already has real backing from its
        // actual launch, so this proves the basket's deposit ADDS to real
        // existing state rather than replacing/double-counting it.
        BackingLens.Backing memory before = BackingLens(LENS).backingOf(_existingTreasury());
        uint256 valueBefore = before.totalValueUsd;

        vm.prank(EXISTING_CREATOR);
        zap.swapBasket{value: 5 ether}(EXISTING_TOKEN, _threeLegs(), block.timestamp + 1 hours);

        address treasury = _existingTreasury();
        _approveAndDeposit(EXISTING_CREATOR, treasury, NVDA);
        _approveAndDeposit(EXISTING_CREATOR, treasury, SGOV);
        _approveAndDeposit(EXISTING_CREATOR, treasury, AMD);

        BackingLens.Backing memory afterBacking = BackingLens(LENS).backingOf(treasury);
        assertGt(afterBacking.totalValueUsd, valueBefore, "basket deposit increased real existing backing");
    }

    function _existingTreasury() internal returns (address treasury) {
        (bool ok, bytes memory ret) = FACTORY.call(abi.encodeWithSignature("launchIdOf(address)", EXISTING_TOKEN));
        require(ok, "launchIdOf failed");
        uint256 id = abi.decode(ret, (uint256));
        (ok, ret) = FACTORY.call(abi.encodeWithSignature("launches(uint256)", id - 1));
        require(ok, "launches failed");
        (, treasury,) = abi.decode(ret, (address, address, address));
    }

    function _approveAndDeposit(address creator, address treasury, address asset) internal {
        uint256 amount = IERC20(asset).balanceOf(creator);
        vm.startPrank(creator);
        IERC20(asset).approve(treasury, amount);
        IProjectTreasuryDeposit(treasury).deposit(asset, amount);
        vm.stopPrank();
    }
}
