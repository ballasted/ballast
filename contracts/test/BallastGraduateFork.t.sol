// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2, Vm} from "forge-std/Test.sol";
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
import {BallastHook, BALLAST_HOOK_FLAGS} from "../src/BallastHook.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {OrderingLib} from "../src/libraries/OrderingLib.sol";
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
        (address ha, bytes32 salt) =
            HookMiner.find(address(this), BALLAST_HOOK_FLAGS, type(BallastHook).creationCode, abi.encode(MANAGER, cfg, WETH));
        hook = new BallastHook{salt: salt}(MANAGER, cfg, WETH);
        require(address(hook) == ha, "hook");
        seeder = new BallastSeeder(MANAGER, address(hook));
        hook.setSeeder(address(seeder));
        ethFeed = new MockAggregator(8, 3000e8, block.timestamp); // ETH = $3000, fresh
        factory = new BallastFactory(address(registry), WETH, seeder, address(ethFeed), 24 hours, new address[](0));
        swap = new PoolSwapTest(MANAGER);
        vm.deal(address(this), 2000 ether);
        IWETH9c(WETH).deposit{value: 1000 ether}();
        IERC20(WETH).approve(address(swap), type(uint256).max);
    }

    /// @dev Salt mining is gone from BallastFactory (step c of the quote-asset
    ///      workstream) — a launched token's address is now plain-CREATE,
    ///      nonce-based, and genuinely unconstrained relative to WETH.
    ///      BallastSeeder now mirrors its one-sided-liquidity math for either
    ///      ordering (step d) and there's a dedicated end-to-end test below
    ///      (test_backedLaunch_currency1_opensAt1xBacking) proving that. Every
    ///      OTHER test in this file is about graduation PRICE math, not
    ///      ordering, so they force currency0 deliberately — it isolates what
    ///      they're actually testing from which side of WETH the token's
    ///      nonce-based address happens to land on. vm.setNonce forces the
    ///      factory's next `new BallastToken(...)` to land at a chosen address
    ///      deterministically, the same outcome mining used to guarantee,
    ///      without pretending mining still exists.
    function _forceNextLaunchCurrency0() internal {
        uint64 nonce = uint64(vm.getNonce(address(factory)));
        while (vm.computeCreateAddress(address(factory), nonce) >= WETH) {
            nonce++;
        }
        vm.setNonce(address(factory), nonce);
    }

    /// @dev The mirror of _forceNextLaunchCurrency0 — forces the next launch's
    ///      token address ABOVE WETH, for the dedicated currency1 end-to-end test.
    function _forceNextLaunchCurrency1() internal {
        uint64 nonce = uint64(vm.getNonce(address(factory)));
        while (vm.computeCreateAddress(address(factory), nonce) <= WETH) {
            nonce++;
        }
        vm.setNonce(address(factory), nonce);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
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

        _forceNextLaunchCurrency0();
        (, address token, address treasury) = factory.launch("Proj", "PRJ", 30 days, "ipfs://proj", _one(WETH));
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

    /// @dev Full factory.launch -> graduate pipeline for a token that sorts as
    ///      currency1 (token > WETH) — the exact ordering CREATE2 mining no
    ///      longer prevents in production. Proves the real entry point, not
    ///      just BallastSeeder in isolation (see BallastSeederFork.t.sol for
    ///      that lower-level proof).
    function test_backedLaunch_currency1_opensAt1xBacking() public {
        if (!forked) return;
        MockStockToken stock = new MockStockToken("Mock NVDA", "MNVDA", 18);
        MockAggregator feed = new MockAggregator(8, 100e8, block.timestamp);
        registry.setAsset(address(stock), address(feed), 3 days, 1e12, MarketHours.UsEquities24_5);

        _forceNextLaunchCurrency1();
        (, address token, address treasury) = factory.launch("Proj1", "PRJ1", 30 days, "ipfs://proj", _one(WETH));
        assertGt(uint160(token), uint160(WETH), "token must sort as currency1 for this test");
        stock.mint(address(this), 1000e18);
        stock.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(stock), 1000e18);

        factory.graduate(token);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        (uint160 sp,,,) = MANAGER.getSlot0(key.toId());
        // raw ratio = currency1/currency0 = token/WETH, 1e18-fixed; invert to
        // get the real price (WETH/token) the product actually quotes.
        uint256 rawRatio = FullMath.mulDiv(uint256(sp) * uint256(sp), 1e18, 1 << 192);
        uint256 poolP0 = FullMath.mulDiv(1e18, 1e18, rawRatio);
        // backing/token = $100k / 1e9 = $0.0001; /$3000 = 3.333e-8 WETH/token.
        uint256 expectedP0 = FullMath.mulDiv(0.0001e18, 1e18, 3000e18);
        assertApproxEqRel(poolP0, expectedP0, 0.02e18, "currency1 pool must open at ~1x backing");
        // NOT checked at rest: MANAGER.getLiquidity(key.toId()). This ordering's
        // one-sided-below-backing range puts its coincident boundary at
        // tickUpper (exclusive under Uniswap's half-open tick convention), so it
        // reads 0 immediately after seeding even though the position holds real
        // committed liquidity — see BallastSeederFork.t.sol's identical case for
        // the full explanation. The buy below crosses that boundary and is the
        // real proof; asserted active afterward too.

        // Buy = WETH(c0) -> token(c1) = zeroForOne TRUE here (flipped vs the
        // currency0 case), then creator claims the WETH fee same as before.
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertGt(MANAGER.getLiquidity(key.toId()), 0, "position active after crossing into range");
        uint256 before = IERC20(WETH).balanceOf(address(this));
        hook.claim();
        uint256 claimed = IERC20(WETH).balanceOf(address(this)) - before;
        assertApproxEqRel(claimed, 0.005 ether, 0.02e18, "creator gets 50% of the 1% fee (currency1)");
    }

    function test_unbackedLaunch_constantP0_endToEnd() public {
        if (!forked) return;
        _forceNextLaunchCurrency0();
        (, address token,) = factory.launch("Meme", "MEME", 7 days, "", _one(WETH));
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

        _forceNextLaunchCurrency0();
        (, address token, address treasury) = factory.launch("F", "F", 30 days, "", _one(WETH));
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
        _forceNextLaunchCurrency0();
        (, address tokA, address trA) = factory.launch("A", "A", 30 days, "", _one(WETH));
        _addBackedAsset(trA, 8, 100e8, 1000e18, 1e18); // uiMultiplier 1.0
        factory.graduate(tokA);

        _forceNextLaunchCurrency0();
        (, address tokB, address trB) = factory.launch("B", "B", 30 days, "", _one(WETH));
        _addBackedAsset(trB, 8, 100e8, 1000e18, 3e18); // uiMultiplier 3.0
        factory.graduate(tokB);

        // Same tick => same P0 (uiMultiplier ignored).
        (, int24 tA,,) = MANAGER.getSlot0(_poolKey(tokA).toId());
        (, int24 tB,,) = MANAGER.getSlot0(_poolKey(tokB).toId());
        assertEq(tA, tB, "uiMultiplier must not change backing/P0");
    }

    function test_mixedAssets_sumBacking() public {
        if (!forked) return;
        _forceNextLaunchCurrency0();
        (, address token, address treasury) = factory.launch("Mix", "MIX", 30 days, "", _one(WETH));
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

        _forceNextLaunchCurrency0();
        (, address token, address treasury) = factory.launch("Stale", "STL", 30 days, "", _one(WETH));
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

        _forceNextLaunchCurrency0();
        (, address token, address treasury) = factory.launch("Quiet", "QT", 30 days, "", _one(WETH));
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

        _forceNextLaunchCurrency0();
        (, address token, address treasury) = factory.launch("EthStale", "ETS", 30 days, "", _one(WETH));
        stock.mint(address(this), 500e18);
        stock.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(stock), 500e18);

        ethFeed.setAnswer(3000e8, block.timestamp - 25 hours); // ETH feed > 24h window
        // Reports the QUOTE ASSET (WETH), not its feed — matches the treasury-asset
        // stale check's convention (which has always reported the asset, not the
        // feed); the old ETH-specific branch was the inconsistent one, fixed here
        // as part of generalizing this check to any quote asset.
        vm.expectRevert(abi.encodeWithSelector(BallastFactory.FeedStaleAtLaunch.selector, WETH));
        factory.graduate(token);
    }

    // ===================================================================== //
    //  Multiple stock pairs: one launch, several quote-asset pools          //
    // ===================================================================== //

    function _poolKeyFor(address token, address quoteAsset) internal view returns (PoolKey memory) {
        (address c0, address c1) = OrderingLib.sort(token, quoteAsset);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    /// @dev One graduate() call seeds TWO pools (WETH + a mock stock quote
    ///      asset) atomically — MAX_QUOTE_ASSETS is 2 (docs/GO_LIVE.md: "one
    ///      launch, multiple quote assets"), so two is the most this contract
    ///      will ever accept, not an arbitrary test choice. 1e9e18 total supply
    ///      doesn't split evenly by 2, exercising the remainder-to-first-pool
    ///      rule as well as the equal-split rule. Each pool independently
    ///      swaps, and each pool's fee lands in its OWN isolated ledger —
    ///      `owed` for WETH, `owedIn[...][X]` for the stock quote asset —
    ///      proving no cross-pool leakage.
    function test_multiQuoteAsset_graduate_seedsAllPools_equalSplit_isolatedFeeLedgers() public {
        if (!forked) return;

        MockStockToken quoteB = new MockStockToken("Mock TSLA", "MTSLA", 18);
        registry.setAsset(
            address(quoteB), address(new MockAggregator(8, 50e8, block.timestamp)), 3 days, 1e12, MarketHours.UsEquities24_5
        );

        address[] memory greens = new address[](1);
        greens[0] = address(quoteB);
        BallastFactory f2 = new BallastFactory(address(registry), WETH, seeder, address(ethFeed), 24 hours, greens);

        address[] memory picks = new address[](2);
        picks[0] = WETH;
        picks[1] = address(quoteB);
        (, address token, address treasury) = f2.launch("Multi", "MLT", 30 days, "", picks);

        MockStockToken backing = new MockStockToken("Mock NVDA", "MNVDA", 18);
        registry.setAsset(
            address(backing), address(new MockAggregator(8, 100e8, block.timestamp)), 3 days, 1e12, MarketHours.UsEquities24_5
        );
        backing.mint(address(this), 1000e18);
        backing.approve(treasury, type(uint256).max);
        ProjectTreasury(treasury).deposit(address(backing), 1000e18);

        uint256 supply = 1_000_000_000e18;
        uint256 share = supply / 2;
        uint256 firstAmount = supply - share; // remainder goes to the first pool (WETH)

        vm.recordLogs();
        f2.graduate(token);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != BallastFactory.PoolSeeded.selector) continue;
            address quoteAsset = address(uint160(uint256(logs[i].topics[2])));
            (,, uint256 amount) = abi.decode(logs[i].data, (bytes32, int24, uint256));
            if (quoteAsset == WETH) assertEq(amount, firstAmount, "WETH pool gets the remainder");
            else assertEq(amount, share, "stock-quoted pool gets an even share");
            found++;
        }
        assertEq(found, 2, "graduate() must emit exactly one PoolSeeded per quote asset");

        // Real liquidity was committed to both pools — proven by the supply
        // actually leaving the factory/seeder, not by MANAGER.getLiquidity() at
        // rest. A one-sided position's range is HALF-OPEN [tickLower, tickUpper)
        // (BallastSeeder's own docs): when the token sorts as currency1, the
        // range's coincident boundary sits at tickUpper (EXCLUSIVE), so
        // getLiquidity() at the resting tick reads 0 immediately after seeding
        // even though the position genuinely holds the full committed amount —
        // the same documented "boundary artifact" BallastSeederForkTest already
        // covers for a single pool. Checked correctly further down, AFTER a
        // buy crosses the tick into each position's active range.
        PoolKey memory keyWeth = _poolKeyFor(token, WETH);
        PoolKey memory keyB = _poolKeyFor(token, address(quoteB));
        assertEq(IERC20(token).balanceOf(address(f2)), 0, "factory holds nothing after graduating all pools");
        // Not assertEq(..., 0): LiquidityAmounts.getLiquidityForAmount0/1 rounds
        // DOWN when converting an exact token amount to a liquidity value, so
        // settling that liquidity back can leave a few hundred wei of dust per
        // pool in the seeder — real, observed on a live fork (813 wei total
        // across 2 pools against a 5e26-token-per-pool amount, i.e. ~1.6e-22%).
        // A tight upper bound still catches a REAL leftover-supply bug; it just
        // doesn't mistake unavoidable sqrt-price rounding for one.
        assertLt(IERC20(token).balanceOf(address(seeder)), 10_000, "seeder holds only rounding dust, not a real leftover");

        // Buy in EACH pool — this is also what proves the liquidity is real and
        // active (crosses into the one-sided range; see the comment above), not
        // just a resting-tick artifact — then confirm fees landed in the RIGHT,
        // ISOLATED ledger, never bleeding into another pool's quote asset.
        quoteB.mint(address(this), 1_000_000e18);
        quoteB.approve(address(swap), type(uint256).max);
        // BallastHook.beforeSwap takes its 1% fee via poolManager.take() BEFORE
        // this swap's own payment settles (v4 flash accounting) — real for WETH
        // because the singleton PoolManager already holds deep real WETH from
        // every other pool on this forked mainnet, but quoteB is a synthetic
        // MockStockToken with ZERO balance anywhere else in the whole chain, so
        // take() has nothing to draw from and reverts on a real ERC20 transfer.
        // A genuine GREEN quote asset (NVDA/SPY/SGOV) never has this problem —
        // it already carries real liquidity in this same PoolManager from its
        // other live pools (see docs/exit-liquidity-table.md). Donate quoteB
        // directly to the PoolManager to simulate that same pre-existing float,
        // not to work around a real bug.
        quoteB.mint(address(MANAGER), 1_000e18);

        _buyOneUnit(keyWeth, WETH);
        _buyOneUnit(keyB, address(quoteB));

        assertGt(MANAGER.getLiquidity(keyWeth.toId()), 0, "WETH pool active after a buy crosses into range");
        assertGt(MANAGER.getLiquidity(keyB.toId()), 0, "quoteB pool active after a buy crosses into range");

        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        hook.claim();
        assertGt(IERC20(WETH).balanceOf(address(this)) - wethBefore, 0, "WETH ledger paid out");

        uint256 bBefore = quoteB.balanceOf(address(this));
        hook.claimIn(address(quoteB));
        assertGt(quoteB.balanceOf(address(this)) - bBefore, 0, "quoteB ledger paid out");

        // Isolation, not just "every ledger happens to be nonzero": claiming
        // quoteB again pays nothing (already swept), proving WETH's swap fee
        // never touched quoteB's ledger, and vice versa implicitly above.
        assertEq(hook.claimIn(address(quoteB)), 0, "quoteB ledger fully drained, no cross-pool leakage");
    }

    /// @dev Buy the project token with 1 unit of `quoteAsset` in `key`, whichever
    ///      side of the pool each currency happens to sort to.
    function _buyOneUnit(PoolKey memory key, address quoteAsset) internal {
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == quoteAsset;
        swap.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: quoteIsCurrency0,
                amountSpecified: -1 ether,
                sqrtPriceLimitX96: quoteIsCurrency0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
