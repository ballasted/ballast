// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastToken} from "../src/BallastToken.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";
import {BallastHook} from "../src/BallastHook.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

interface IWETH9c {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev Slice-3 end-to-end on a mainnet fork: launch -> deposit backing -> graduate
///      (backing-derived P0, freshness-gated) -> buy -> claim fees. Plus unbacked
///      launch and the FeedStaleAtLaunch gate. Uses MOCK fresh feeds (the real
///      SGOV feed is resting on the fork). Skips offline.
contract BallastGraduateForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    AssetRegistry registry;
    FeeConfig cfg;
    BallastHook hook;
    BallastSeeder seeder;
    BallastFactory factory;
    PoolSwapTest swap;
    MockAggregator ethFeed;
    address platform = makeAddr("platform");
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        registry = new AssetRegistry(address(this));
        cfg = new FeeConfig(address(this), platform);
        uint160 flags = uint160((1 << 7) | (1 << 6) | (1 << 3) | (1 << 2));
        (address ha, bytes32 salt) =
            HookMiner.find(address(this), flags, type(BallastHook).creationCode, abi.encode(MANAGER, cfg, WETH));
        hook = new BallastHook{salt: salt}(MANAGER, cfg, WETH);
        require(address(hook) == ha, "hook");
        seeder = new BallastSeeder(MANAGER, WETH, address(hook));
        ethFeed = new MockAggregator(8, 3000e8, block.timestamp); // ETH = $3000, fresh
        factory = new BallastFactory(address(registry), WETH, seeder, address(ethFeed), 24 hours, 5 ether);
        swap = new PoolSwapTest(MANAGER);
        vm.deal(address(this), 2000 ether);
        IWETH9c(WETH).deposit{value: 1000 ether}();
        IERC20(WETH).approve(address(swap), type(uint256).max);
    }

    function _poolPrice1e18(PoolKey memory key) internal view returns (uint256) {
        (uint160 sp,,,) = MANAGER.getSlot0(key.toId());
        // price = (sp/2^96)^2, currency1/currency0 = WETH/token. Return 1e18-scaled.
        return FullMath.mulDiv(uint256(sp) * uint256(sp), 1e18, 1 << 192);
    }

    function test_backedLaunch_opensAt1xBacking_thenBuyAndClaim() public {
        if (!forked) return;
        // A fresh backing asset ($100) with a mock feed.
        MockStockToken stock = new MockStockToken("Mock NVDA", "MNVDA", 18);
        MockAggregator feed = new MockAggregator(8, 100e8, block.timestamp);
        registry.setAsset(address(stock), address(feed), 3 days, 1e12, MarketHours.UsEquities24_5);

        (, address token, address treasury) = factory.launch("Proj", "PRJ", 30 days, "ipfs://proj");
        // Deposit 1000 stock ($100k backing) as creator (msg.sender == this).
        stock.mint(address(this), 1000e18);
        stock.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(stock), 1000e18);

        factory.graduate(token);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token),
            currency1: Currency.wrap(WETH),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        // backing/token = $100k / 1e9 = $0.0001; /$3000 = 3.333e-8 WETH/token.
        uint256 expectedP0 = FullMath.mulDiv(0.0001e18, 1e18, 3000e18);
        uint256 poolP0 = _poolPrice1e18(key);
        console2.log("expected P0 (WETH/token 1e18):", expectedP0);
        console2.log("pool     P0 (WETH/token 1e18):", poolP0);
        assertApproxEqRel(poolP0, expectedP0, 0.02e18, "pool must open at ~1x backing");
        assertGt(MANAGER.getLiquidity(key.toId()), 0, "seeded liquidity");

        // Buy (WETH -> token, zeroForOne=false), then creator claims the WETH fee.
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        // creator == this (the launcher); fee is 1% of 1 WETH = 0.01, 50% to creator.
        uint256 before = IERC20(WETH).balanceOf(address(this));
        hook.claim();
        uint256 claimed = IERC20(WETH).balanceOf(address(this)) - before;
        console2.log("creator claimed WETH:", claimed);
        assertApproxEqRel(claimed, 0.005 ether, 0.02e18, "creator gets 50% of the 1% fee");
    }

    function test_unbackedLaunch_constantP0_endToEnd() public {
        if (!forked) return;
        (, address token,) = factory.launch("Meme", "MEME", 7 days, "");
        factory.graduate(token); // no treasury assets -> UNBACKED_TICK

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token),
            currency1: Currency.wrap(WETH),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        assertGt(MANAGER.getLiquidity(key.toId()), 0, "unbacked pool seeded");
        (, int24 tick,,) = MANAGER.getSlot0(key.toId());
        assertEq(tick, factory.UNBACKED_TICK(), "unbacked opens at constant tick");

        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        hook.claim(); // creator claims; no revert
    }

    // Helper: fund creator + deposit an amount of a fresh mock asset, return its USD price feed answer.
    function _addBackedAsset(address treasury, uint8 feedDec, uint256 priceUsd, uint256 amount, uint256 uiMul)
        internal
        returns (MockStockToken stock)
    {
        stock = new MockStockToken("Mock", "MK", 18);
        if (uiMul != 0) stock.setUiMultiplier(uiMul);
        MockAggregator feed = new MockAggregator(feedDec, int256(priceUsd), block.timestamp);
        registry.setAsset(address(stock), address(feed), 3 days, 1, MarketHours.UsEquities24_5);
        stock.mint(address(this), amount);
        stock.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(stock), amount);
    }

    function _poolKey(address token) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(token),
            currency1: Currency.wrap(WETH),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    /// forge-config: default.fuzz.runs = 40
    function testFuzz_backedGraduate_opensNear1x(uint256 amount, uint256 ethUsd, uint8 decSel) public {
        if (!forked) return;
        uint8 feedDec = [6, 8, 18][decSel % 3]; // fuzz feed decimals != 8
        amount = bound(amount, 1e18, 1_000_000e18); // token units held
        ethUsd = bound(ethUsd, 200e8, 10_000e8); // ETH/USD at 8 dec
        ethFeed.setAnswer(int256(ethUsd), block.timestamp);

        (, address token, address treasury) = factory.launch("F", "F", 30 days, "");
        _addBackedAsset(treasury, feedDec, 100 * (10 ** feedDec), amount, 0); // $100 asset
        factory.graduate(token);

        // expected backing = amount * $100 ; per token / ethPrice
        uint256 v = amount * 100; // 1e18-scaled USD (amount is 18-dec, $100 whole)
        uint256 expectedP0 = FullMath.mulDiv(FullMath.mulDiv(v, 1e18, 1_000_000_000e18), 1e18, FullMath.mulDiv(ethUsd, 1e18, 1e8));
        uint256 poolP0 = _poolPrice1e18(_poolKey(token));
        assertLe(poolP0, FullMath.mulDiv(expectedP0, 1001, 1000), "above 1x");
        assertGe(poolP0, FullMath.mulDiv(expectedP0, 990, 1000), ">1% below 1x");
    }

    function test_uiMultiplier_notApplied_toFeedPrice() public {
        if (!forked) return;
        // Two identical launches; one asset has uiMultiplier 3x. Backing (hence P0)
        // must be IDENTICAL — the feed price already embeds the multiplier (rule 7).
        (, address tokA, address trA) = factory.launch("A", "A", 30 days, "");
        _addBackedAsset(trA, 8, 100e8, 1000e18, 1e18); // uiMultiplier 1.0
        factory.graduate(tokA);

        (, address tokB, address trB) = factory.launch("B", "B", 30 days, "");
        _addBackedAsset(trB, 8, 100e8, 1000e18, 3e18); // uiMultiplier 3.0
        factory.graduate(tokB);

        // Same tick => same P0 (uiMultiplier ignored).
        (, int24 tA,,) = MANAGER.getSlot0(_poolKey(tokA).toId());
        (, int24 tB,,) = MANAGER.getSlot0(_poolKey(tokB).toId());
        assertEq(tA, tB, "uiMultiplier must not change backing/P0");
    }

    function test_mixedAssets_sumBacking() public {
        if (!forked) return;
        (, address token, address treasury) = factory.launch("Mix", "MIX", 30 days, "");
        _addBackedAsset(treasury, 8, 100e8, 500e18, 0); // $50k
        _addBackedAsset(treasury, 18, 2e18, 10_000e18, 0); // $20k (2 USD, 18-dec feed)
        factory.graduate(token);

        uint256 v = 500e18 * 100 + 10_000e18 * 2; // $70k, 1e18-scaled
        uint256 expectedP0 = FullMath.mulDiv(FullMath.mulDiv(v, 1e18, 1_000_000_000e18), 1e18, 3000e18);
        uint256 poolP0 = _poolPrice1e18(_poolKey(token));
        assertApproxEqRel(poolP0, expectedP0, 0.01e18, "mixed-asset backing sum wrong");
    }

    // Coarse backstop: a treasury feed stale beyond its per-asset staleAfter (3d
    // here) reverts, so P0 can never be pinned to a dead price permanently.
    function test_graduateReverts_whenBackingFeedStaleBeyondBound() public {
        if (!forked) return;
        MockStockToken stock = new MockStockToken("Mock AAPL", "MAAPL", 18);
        MockAggregator feed = new MockAggregator(8, 200e8, block.timestamp - 4 days); // > 3d staleAfter
        registry.setAsset(address(stock), address(feed), 3 days, 1e12, MarketHours.UsEquities24_5);

        (, address token, address treasury) = factory.launch("Stale", "STL", 30 days, "");
        stock.mint(address(this), 500e18);
        stock.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(stock), 500e18);

        vm.expectRevert(abi.encodeWithSelector(BallastFactory.FeedStaleAtLaunch.selector, address(stock)));
        factory.graduate(token);
    }

    // The behavioral change from the old 1h FRESH_WINDOW: a feed that's QUIET but
    // still within its outer bound (2h old, 3d staleAfter) is a CORRECT price on a
    // deviation-threshold feed, so graduation now proceeds instead of reverting.
    // The old 1h constant would have bricked this launch.
    function test_graduateSucceeds_whenBackingFeedQuietButWithinBound() public {
        if (!forked) return;
        MockStockToken stock = new MockStockToken("Mock AAPL", "MAAPL", 18);
        MockAggregator feed = new MockAggregator(8, 200e8, block.timestamp - 2 hours); // quiet, < 3d bound
        registry.setAsset(address(stock), address(feed), 3 days, 1e12, MarketHours.UsEquities24_5);

        (, address token, address treasury) = factory.launch("Quiet", "QT", 30 days, "");
        stock.mint(address(this), 500e18);
        stock.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(stock), 500e18);

        factory.graduate(token); // no revert
        assertGt(MANAGER.getLiquidity(_poolKey(token).toId()), 0, "quiet-but-fresh feed must still seed");
    }

    // The ETH/USD leg uses the immutable ethUsdStaleWindow (24h), not the registry.
    // Beyond it, graduation reverts even when the treasury feed is fine.
    function test_graduateReverts_whenEthFeedStaleBeyondWindow() public {
        if (!forked) return;
        MockStockToken stock = new MockStockToken("Mock NVDA", "MNVDA", 18);
        MockAggregator feed = new MockAggregator(8, 100e8, block.timestamp); // treasury feed fresh
        registry.setAsset(address(stock), address(feed), 3 days, 1e12, MarketHours.UsEquities24_5);

        (, address token, address treasury) = factory.launch("EthStale", "ETS", 30 days, "");
        stock.mint(address(this), 500e18);
        stock.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(stock), 500e18);

        ethFeed.setAnswer(3000e8, block.timestamp - 25 hours); // ETH feed > 24h window
        vm.expectRevert(abi.encodeWithSelector(BallastFactory.FeedStaleAtLaunch.selector, address(ethFeed)));
        factory.graduate(token);
    }
}
