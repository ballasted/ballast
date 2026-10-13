// SPDX-License-Identifier: MIT
// 0.8.26 — shares BasketZap's import graph (v4-periphery's V4Router), same
// reason BallastRouterV2.t.sol carries the identical pin.
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BasketZap} from "../src/BasketZap.sol";
import {DeployBasketZap} from "../script/DeployBasketZap.s.sol";

interface IBallastFactoryFull {
    function launch(string calldata name_, string calldata symbol_, uint256 noticePeriod, string calldata metadataURI, address[] calldata quoteAssets_)
        external
        returns (uint256 id, address token, address treasury);
}

interface IProjectTreasuryDeposit {
    function deposit(address asset, uint256 amount) external;
}

/// @dev MUST match BackingLens.sol's Backing / AssetBacking / SequencerStatus
///      exactly — BackingLens is pinned to 0.8.28 and can't be imported into
///      this 0.8.26 file, so its public struct is mirrored here by hand. A
///      field-order or type mismatch makes the ABI decode of `backingOf()`
///      revert (verified against contracts/src/BackingLens.sol:48-82).
interface IBackingLensLike {
    enum SequencerStatus {
        Unknown,
        Up,
        GracePeriod,
        Down
    }

    struct AssetBacking {
        address asset;
        uint256 lockedBalance;
        uint256 withdrawableBalance;
        uint256 price;
        uint8 priceDecimals;
        uint8 assetDecimals;
        uint256 updatedAt;
        uint8 marketHours;
        uint256 lockedValueUsd;
        uint256 withdrawableValueUsd;
        bool priced;
        bool stale;
        bool oraclePaused;
    }

    struct Backing {
        SequencerStatus sequencerStatus;
        uint256 totalSupply;
        uint256 lockedValueUsd;
        uint256 withdrawableValueUsd;
        uint256 totalValueUsd;
        uint256 backingPerToken;
        uint256 lockedBackingPerToken;
        bool anyStale;
        bool anyUnpriced;
        AssetBacking[] assets;
    }

    function backingOf(address treasury) external view returns (Backing memory);
}

/// @notice BasketZap exercised against REAL Robinhood Chain mainnet state: the
///         real BallastFactory, the real AssetRegistry and its real Chainlink
///         feeds, a real existing launch, a freshly-created launch via the
///         real factory, and — for the end-to-end swap assertions — the REAL
///         production Fables/Ramses routes (docs/BASKET_DISCOVERY.md §2).
///
/// @dev REWRITE (this session): the prior version of this file seeded a
///      throwaway v4 pool via test/helpers/TestPoolSeeder.sol because, at the
///      time, no real route existed for any AssetRegistry-listed asset — that
///      was a test-only unblock, explicitly NOT a production route. Real
///      routes now exist (same Fables/Ramses tables BallastRouterV2 already
///      uses, reused verbatim via DeployBasketZap's pure builder functions),
///      so these tests now prove the ACTUAL production path end-to-end —
///      pool existence and AssetRegistry allowlisting are no longer
///      independent concerns requiring a seed shim.
///
/// SKIPS unless RH_RPC_URL_PAID is set (division of labour: the human/CI runs
/// tests with the RPC).
contract BasketZapForkTest is Test {
    address constant LENS = 0x73Ac3574c8743553f41C6E25F92A145b5c0e7240;

    // Launch id 2 on the current factory — a real, non-Safe-owned, graduated
    // launch (confirmed live on-chain, docs/BASKET_DISCOVERY.md §1).
    address constant EXISTING_TOKEN = 0x10842066A3334d76CBBc206D26C670db9768A4BF;
    address constant EXISTING_CREATOR = 0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85;

    address constant NOT_AN_ASSET = address(0x000000000000000000000000000000DeadBeef);

    BasketZap zap;
    DeployBasketZap deployHelper;
    address factory;
    address registry;
    address weth;
    bool forked;

    // Token addresses cached as plain storage reads in setUp. CRITICAL: never
    // call `deployHelper.NVDA()` (an EXTERNAL staticcall) inline in an argument
    // or cheatcode-argument position — Foundry's `vm.prank` / `vm.expectRevert`
    // apply to the NEXT external call, and an inline `deployHelper.X()` IS that
    // next call, silently consuming the cheatcode before `swapBasket` runs.
    // Reading these storage vars is a plain SLOAD, not a call, so it's safe.
    address nvda;
    address sgov;
    address amd;
    address spy;
    address meta;

    // Real per-ticker hop indices, read off DeployBasketZap's own index map —
    // never re-derived here. The pipeline (swap -> deposit -> BackingLens)
    // tests deliberately use NVDA/SPY/META, the three assets with DIRECT
    // WETH/<asset> Ramses pools (indices 0/1/2 — the deepest per the deploy
    // script), so the deposit-sizing never depends on a thin 2-hop-via-USDG
    // route. SGOV/AMD (2-hop, thinner) are kept only for the venue-fallback
    // and bad-route assertions, which don't deposit.
    uint256[] NVDA_RAMSES;
    uint256[] SPY_RAMSES;
    uint256[] META_RAMSES;
    uint256[] SGOV_RAMSES; // no Fables route for SGOV; 2-hop via USDG
    uint256[] AMD_RAMSES; // no Fables route for AMD; 2-hop via USDG
    uint256[] EMPTY;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);

        deployHelper = new DeployBasketZap();
        factory = deployHelper.FACTORY();
        registry = deployHelper.REGISTRY();
        weth = deployHelper.WETH();
        nvda = deployHelper.NVDA();
        sgov = deployHelper.SGOV();
        amd = deployHelper.AMD();
        spy = deployHelper.SPY();
        meta = deployHelper.META();

        zap = new BasketZap(
            factory,
            registry,
            IPoolManager(deployHelper.POOL_MANAGER()),
            weth,
            deployHelper.buildFablesHops(),
            deployHelper.buildRamsesRoutes()
        );

        NVDA_RAMSES = _arr1(0);
        SPY_RAMSES = _arr1(1);
        META_RAMSES = _arr1(2);
        SGOV_RAMSES = _arr2(4, 12);
        AMD_RAMSES = _arr2(4, 15);

        forked = true;
    }

    function _arr1(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _arr2(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _legRamsesOnly(address asset, uint16 weightBps, uint256[] memory ramsesIdx, uint256 minOut)
        internal
        view
        returns (BasketZap.Leg memory)
    {
        return BasketZap.Leg({
            asset: asset,
            weightBps: weightBps,
            preferFables: false,
            fablesHopIdx: EMPTY,
            ramsesHopIdx: ramsesIdx,
            minOut: minOut
        });
    }

    function _oneLeg(address asset, uint256[] memory ramsesIdx, uint256 minOut)
        internal
        view
        returns (BasketZap.Leg[] memory legs)
    {
        legs = new BasketZap.Leg[](1);
        legs[0] = _legRamsesOnly(asset, 10_000, ramsesIdx, minOut);
    }

    /// @dev NVDA + SPY only — the two assets with confirmed-deep DIRECT WETH
    ///      Ramses pools (indices 0 and 1). META's direct Ramses pool (index 2)
    ///      returns ~0 output at this size on mainnet (floored/near-dead, as the
    ///      deploy-script routing note flags), so it's deliberately NOT used in
    ///      the deposit-pipeline tests — that's a liquidity fact about that one
    ///      pool, surfaced in docs/BASKET_DISCOVERY.md, not a BasketZap defect.
    function _deepBasket() internal view returns (BasketZap.Leg[] memory legs) {
        legs = new BasketZap.Leg[](2);
        legs[0] = _legRamsesOnly(nvda, 6_000, NVDA_RAMSES, 1);
        legs[1] = _legRamsesOnly(spy, 4_000, SPY_RAMSES, 1);
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
        assertEq(address(zap.factory()), factory);
        assertEq(address(zap.registry()), registry);
        assertEq(zap.weth(), weth);
        assertEq(zap.fablesHopsLength(), 12);
        assertEq(zap.ramsesRoutesLength(), 17);
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
        zap.swapBasket{value: 1 ether}(EXISTING_TOKEN, _oneLeg(nvda, NVDA_RAMSES, 1), block.timestamp + 1 hours);
    }

    function test_fork_revertsForUnknownLaunch_realFactory() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address notALaunch = makeAddr("notALaunch");
        vm.deal(address(this), 1 ether);
        vm.expectRevert(BasketZap.UnknownLaunch.selector);
        zap.swapBasket{value: 1 ether}(notALaunch, _oneLeg(nvda, NVDA_RAMSES, 1), block.timestamp + 1 hours);
    }

    function test_fork_revertsForUnlistedAsset_realRegistry() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.deal(EXISTING_CREATOR, 1 ether);
        vm.prank(EXISTING_CREATOR);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.AssetNotAllowed.selector, NOT_AN_ASSET));
        zap.swapBasket{value: 1 ether}(EXISTING_TOKEN, _oneLeg(NOT_AN_ASSET, EMPTY, 1), block.timestamp + 1 hours);
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
        zap.swapBasket{value: 1 ether}(EXISTING_TOKEN, _oneLeg(EXISTING_TOKEN, EMPTY, 1), block.timestamp + 1 hours);
    }

    // ── The Chainlink freshness gate against a REAL live feed ────────────

    function test_fork_realAssetPassesFreshnessGate_andSwapSucceeds() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.deal(EXISTING_CREATOR, 1 ether);
        vm.prank(EXISTING_CREATOR);
        (bool ok, bytes memory ret) = address(zap).call{value: 0.01 ether}(
            abi.encodeCall(
                BasketZap.swapBasket, (EXISTING_TOKEN, _oneLeg(spy, _arr1(1), 1), block.timestamp + 1 hours)
            )
        );
        // SPY's real Ramses route is index 1 (WETH/SPY direct) — a real,
        // liquid pool per docs/BASKET_DISCOVERY.md §2, so this should succeed
        // outright rather than merely clear the pre-swap gate.
        bytes4 sel = _revertSelector(ret);
        assertTrue(sel != BasketZap.AssetNotAllowed.selector, "should not fail the allowlist check");
        assertTrue(sel != BasketZap.StalePrice.selector, "SPY's real feed should not be stale right now");
        assertTrue(sel != BasketZap.InvalidPrice.selector, "SPY's real feed should return a valid answer");
        assertTrue(sel != BasketZap.PriceDeviationTooLarge.selector, "first-ever read has no prior price to deviate from");
        assertTrue(ok, "expected a real successful swap against the live SPY/WETH Ramses pool");
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
        quoteAssets[0] = weth;
        vm.prank(creator);
        (, address token, address treasury) =
            IBallastFactoryFull(factory).launch("E2E Basket Test", "E2EB", 7 days, "ipfs://test", quoteAssets);

        // 1 ETH split 60/40 across NVDA/SPY keeps each leg's output well above
        // its AssetRegistry minDeposit (both 1e17) through the deep direct-WETH
        // Ramses pools.
        vm.prank(creator);
        zap.swapBasket{value: 1 ether}(token, _deepBasket(), block.timestamp + 1 hours);

        assertGt(IERC20(nvda).balanceOf(creator), 0, "creator received NVDA");
        assertGt(IERC20(spy).balanceOf(creator), 0, "creator received SPY");

        _approveAndDeposit(creator, treasury, nvda);
        _approveAndDeposit(creator, treasury, spy);

        IBackingLensLike.Backing memory backing = IBackingLensLike(LENS).backingOf(treasury);
        assertEq(backing.assets.length, 2, "both legs tracked by the treasury");
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
        IBackingLensLike.Backing memory before = IBackingLensLike(LENS).backingOf(_existingTreasury());
        uint256 valueBefore = before.totalValueUsd;

        vm.prank(EXISTING_CREATOR);
        zap.swapBasket{value: 1 ether}(EXISTING_TOKEN, _deepBasket(), block.timestamp + 1 hours);

        address treasury = _existingTreasury();
        _approveAndDeposit(EXISTING_CREATOR, treasury, nvda);
        _approveAndDeposit(EXISTING_CREATOR, treasury, spy);

        IBackingLensLike.Backing memory afterBacking = IBackingLensLike(LENS).backingOf(treasury);
        assertGt(afterBacking.totalValueUsd, valueBefore, "basket deposit increased real existing backing");
    }

    // ── Per-leg venue fallback, against REAL pools ────────────────────────

    function test_fork_fallsBackToRamses_whenFablesHopIdxEmpty() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // preferFables=true but fablesHopIdx is empty (SGOV has no Fables
        // route) — must fall straight to Ramses and still succeed, never
        // revert AllVenuesFailedForLeg just because the preferred venue has
        // nothing configured.
        vm.deal(EXISTING_CREATOR, 1 ether);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = BasketZap.Leg({
            asset: sgov,
            weightBps: 10_000,
            preferFables: true,
            fablesHopIdx: EMPTY,
            ramsesHopIdx: SGOV_RAMSES,
            minOut: 1
        });

        vm.prank(EXISTING_CREATOR);
        (uint256[] memory amountsOut, bool[] memory usedFables) =
            zap.swapBasket{value: 0.05 ether}(EXISTING_TOKEN, legs, block.timestamp + 1 hours);

        assertGt(amountsOut[0], 0);
        assertFalse(usedFables[0], "SGOV has no Fables route, must report Ramses used");
    }

    function test_fork_revertsAllVenuesFailed_badRamsesIdx_noFablesConfigured() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // SGOV has no Fables route; feeding a deliberately-wrong Ramses chain
        // (index 0 is NVDA/WETH, doesn't connect from WETH to SGOV) must
        // exhaust both venues and revert AllVenuesFailedForLeg, not silently
        // return zero.
        vm.deal(EXISTING_CREATOR, 1 ether);
        BasketZap.Leg[] memory legs = new BasketZap.Leg[](1);
        legs[0] = BasketZap.Leg({
            asset: sgov,
            weightBps: 10_000,
            preferFables: false,
            fablesHopIdx: EMPTY,
            ramsesHopIdx: _arr1(0),
            minOut: 1
        });

        vm.prank(EXISTING_CREATOR);
        vm.expectRevert(abi.encodeWithSelector(BasketZap.AllVenuesFailedForLeg.selector, sgov));
        zap.swapBasket{value: 0.05 ether}(EXISTING_TOKEN, legs, block.timestamp + 1 hours);
    }

    function test_fork_minOutReverts_regardlessOfVenue() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.deal(EXISTING_CREATOR, 1 ether);
        vm.prank(EXISTING_CREATOR);
        vm.expectRevert(); // InsufficientOutput — exact amount depends on live price, just confirm it reverts
        zap.swapBasket{value: 0.01 ether}(
            EXISTING_TOKEN, _oneLeg(nvda, NVDA_RAMSES, type(uint256).max), block.timestamp + 1 hours
        );
    }

    function _existingTreasury() internal returns (address treasury) {
        (bool ok, bytes memory ret) = factory.call(abi.encodeWithSignature("launchIdOf(address)", EXISTING_TOKEN));
        require(ok, "launchIdOf failed");
        uint256 id = abi.decode(ret, (uint256));
        (ok, ret) = factory.call(abi.encodeWithSignature("launches(uint256)", id - 1));
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
