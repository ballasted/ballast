// SPDX-License-Identifier: MIT
// 0.8.26 — shares BallastRouterV2's import graph (v4-periphery's V4Router).
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";

import {BallastRouterV2} from "../src/BallastRouterV2.sol";
import {DeployBallastRouterV2} from "../script/DeployBallastRouterV2.s.sol";

/// @dev Thin ABI-only view of the deployed BallastRouter v1 (0.8.28 — a different
///      compiler version than this file, so the real contract can't be imported here;
///      an interface needs no shared import graph, only a matching selector).
interface IBallastRouterV1 {
    function buyWithETH(address quoteAsset, uint256 routeIndex, address ballastToken, address hook, uint256 minOut, uint256 deadline)
        external
        payable
        returns (uint256 out);
}

/// @dev Minimal mintable ERC20 standing in for a Ballast-launched token, so leg 2
///      (quoteAsset -> ballastToken, our own hook) can be exercised against a REAL,
///      liquid v4 pool without touching the production BallastHook/Factory (off
///      limits per the Fables-integration brief) or needing a real launch for all 16
///      quote assets. Leg 2's mechanics (SETTLE_ALL/TAKE_ALL/payer resolution via
///      V4Router) don't depend on which hook is on the pool; the Fables-vs-Ramses
///      routing under test is entirely in leg 1.
contract MockBallastToken is ERC20 {
    constructor() ERC20("Mock Ballast Token", "mBAL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BallastRouterV2ForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int24 constant TICK_SPACING = 60;

    BallastRouterV2 router;
    V4Quoter quoter;
    PoolModifyLiquidityTest lpRouter;
    MockBallastToken ballastToken;

    DeployBallastRouterV2 deployHelper;
    bool forked;

    struct Ticker {
        string symbol;
        address token;
        uint256[] fablesHopIdx; // buy direction (ETH -> ... -> quoteAsset); empty = no Fables route
        uint256[] ramsesHopIdx; // buy direction (WETH -> ... -> quoteAsset)
        bool preferFables; // off-chain venue choice at 0.1-1 ETH size, per research + Fables-team guidance
        address hook; // our pool's hook for (token, ballastToken) — address(0) test pool, see MockBallastToken
    }

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("BallastRouterV2ForkTest: skipped (RH_RPC_URL_PAID unset)");
            return;
        }
        vm.createSelectFork(rpc);
        forked = true;

        deployHelper = new DeployBallastRouterV2();
        router = new BallastRouterV2(
            IPoolManager(POOL_MANAGER),
            deployHelper.WETH(),
            deployHelper.buildRamsesRoutes(),
            deployHelper.buildFablesHops()
        );
        quoter = new V4Quoter(IPoolManager(POOL_MANAGER));
        lpRouter = new PoolModifyLiquidityTest(IPoolManager(POOL_MANAGER));
        ballastToken = new MockBallastToken();

        vm.deal(address(this), 10_000 ether);

        address[16] memory allQuoteAssets = [
            deployHelper.SGOV(),
            deployHelper.NVDA(),
            deployHelper.TSLA(),
            deployHelper.GOOGL(),
            deployHelper.AAPL(),
            deployHelper.MSFT(),
            deployHelper.AMZN(),
            deployHelper.META(),
            deployHelper.SPY(),
            deployHelper.QQQ(),
            deployHelper.AMD(),
            deployHelper.COIN(),
            deployHelper.PLTR(),
            deployHelper.ORCL(),
            deployHelper.MSTR(),
            deployHelper.CRCL()
        ];
        for (uint256 i = 0; i < allQuoteAssets.length; i++) {
            _seedOurPool(allQuoteAssets[i]);
        }
    }

    /// @dev Initializes a fresh, hookless, deeply-liquid v4 pool between `quoteAsset`
    ///      and the shared `ballastToken` mock — this test's stand-in for "our pool".
    function _seedOurPool(address quoteAsset) internal {
        bool qIsC0 = quoteAsset < address(ballastToken);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(qIsC0 ? quoteAsset : address(ballastToken)),
            currency1: Currency.wrap(qIsC0 ? address(ballastToken) : quoteAsset),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        IPoolManager(POOL_MANAGER).initialize(key, SQRT_PRICE_1_1);

        deal(quoteAsset, address(this), 10_000_000 ether);
        ballastToken.mint(address(this), 10_000_000 ether);
        IERC20(quoteAsset).approve(address(lpRouter), type(uint256).max);
        ballastToken.approve(address(lpRouter), type(uint256).max);

        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -120_000, tickUpper: 120_000, liquidityDelta: 1e24, salt: 0}),
            bytes("")
        );
    }

    function _hookFor(address) internal pure returns (address) {
        return address(0);
    }

    function _idx1(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _idx2(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _idx3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _empty() internal pure returns (uint256[] memory r) {
        r = new uint256[](0);
    }

    /// @dev The 16 quote-asset tickers, each with its buy-direction hop lists and the
    ///      off-chain `preferFables` default established in phase-1/phase-2 research
    ///      (see DeployBallastRouterV2's index-map comments): Fables wins at 0.1-1 ETH
    ///      for every Fables-eligible ticker except PLTR and COIN (Fables-team
    ///      guidance 2026-10-03: stay on Ramses until liquidity deepens); SGOV/GOOGL/
    ///      MSFT/AMD/ORCL have no Fables pool at all.
    function _tickers() internal view returns (Ticker[] memory t) {
        t = new Ticker[](16);
        t[0] = Ticker("NVDA", deployHelper.NVDA(), _idx2(0, 1), _idx1(0), true, address(0));
        t[1] = Ticker("AAPL", deployHelper.AAPL(), _idx2(0, 2), _idx2(4, 5), true, address(0));
        t[2] = Ticker("META", deployHelper.META(), _idx2(0, 3), _idx2(4, 2 /*unused placeholder, see below*/), true, address(0));
        t[3] = Ticker("TSLA", deployHelper.TSLA(), _idx2(0, 4), _idx2(4, 6), true, address(0));
        t[4] = Ticker("AMZN", deployHelper.AMZN(), _idx2(0, 5), _idx2(4, 7), true, address(0));
        t[5] = Ticker("CRCL", deployHelper.CRCL(), _idx2(0, 6), _idx2(4, 11), true, address(0));
        t[6] = Ticker("MSTR", deployHelper.MSTR(), _idx2(0, 7), _idx2(4, 10), true, address(0));
        t[7] = Ticker("COIN", deployHelper.COIN(), _idx2(0, 8), _idx2(4, 8), false, address(0));
        t[8] = Ticker("PLTR", deployHelper.PLTR(), _idx2(0, 9), _idx2(4, 9), false, address(0));
        t[9] = Ticker("SPY", deployHelper.SPY(), _idx2(0, 10), _idx1(1), true, address(0));
        t[10] = Ticker("QQQ", deployHelper.QQQ(), _idx3(0, 10, 11), _idx1(3), true, address(0));
        t[11] = Ticker("SGOV", deployHelper.SGOV(), _empty(), _idx2(4, 12), false, address(0));
        t[12] = Ticker("GOOGL", deployHelper.GOOGL(), _empty(), _idx2(4, 13), false, address(0));
        t[13] = Ticker("MSFT", deployHelper.MSFT(), _empty(), _idx2(4, 14), false, address(0));
        t[14] = Ticker("AMD", deployHelper.AMD(), _empty(), _idx2(4, 15), false, address(0));
        t[15] = Ticker("ORCL", deployHelper.ORCL(), _empty(), _idx2(4, 16), false, address(0));
        // META's Ramses route is index 2 (direct WETH pool) — fix the placeholder above.
        t[2].ramsesHopIdx = _idx1(2);
    }

    // ===================================================================== //
    //  Buy + sell, every ticker, 0.1 ETH and 1 ETH                          //
    // ===================================================================== //

    function test_buyAndSell_allTickers_bothSizes() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        Ticker[] memory ts = _tickers();
        for (uint256 i = 0; i < ts.length; i++) {
            _buyThenSell(ts[i], 0.1 ether);
            _buyThenSell(ts[i], 1 ether);
        }
    }

    function _buyThenSell(Ticker memory tk, uint256 ethIn) internal {
        uint256 balBefore = ballastToken.balanceOf(address(this));
        (uint256 boughtOut, bool usedFables) = router.buyWithETH{value: ethIn}(
            tk.fablesHopIdx, tk.ramsesHopIdx, tk.preferFables, tk.token, address(ballastToken), tk.hook, 1, block.timestamp + 300
        );
        assertGt(boughtOut, 0, string.concat(tk.symbol, ": buy produced zero output"));
        assertEq(
            ballastToken.balanceOf(address(this)) - balBefore,
            boughtOut,
            string.concat(tk.symbol, ": buy output didn't land on caller")
        );
        console2.log(tk.symbol, usedFables ? "buy via Fables, got:" : "buy via Ramses, got:", boughtOut);

        uint256 ethBefore = address(this).balance;
        ballastToken.approve(address(router), boughtOut);
        (uint256 soldOut, bool usedFablesSell) = router.sellToETH(
            address(ballastToken), boughtOut, tk.token, tk.hook, tk.fablesHopIdx, tk.ramsesHopIdx, tk.preferFables, 1, block.timestamp + 300
        );
        assertGt(soldOut, 0, string.concat(tk.symbol, ": sell produced zero output"));
        assertEq(address(this).balance - ethBefore, soldOut, string.concat(tk.symbol, ": sell ETH didn't land on caller"));
        console2.log(tk.symbol, usedFablesSell ? "sell via Fables, got:" : "sell via Ramses, got:", soldOut);
    }

    // ===================================================================== //
    //  Fallback: a size that genuinely reverts the preferred venue           //
    // ===================================================================== //

    /// @notice Was previously live-liquidity-dependent (Fables-team guidance
    ///         2026-10-03: QQQ's Fables path was deep only for small tickets,
    ///         reverting at 2 ETH on that date's real pool state) -- flaky by
    ///         construction, since real market depth moves over time (it since
    ///         stopped reverting at 2 ETH, failing this test on unrelated
    ///         liquidity changes, not a router bug). Now forces the fallback
    ///         deterministically: `attemptFablesBuy` is `onlySelf` and only
    ///         ever called via `this.attemptFablesBuy{value}(...)` inside
    ///         `_tryFablesBuy`'s try/catch, so mocking that exact selector to
    ///         always revert on the router's own address exercises the real
    ///         fallback code path without depending on any pool's real state.
    function test_fallback_whenPreferredVenueReverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        Ticker memory qqq = _tickers()[10];
        vm.mockCallRevert(
            address(router), abi.encodeWithSelector(router.attemptFablesBuy.selector), "forced: preferred venue unavailable"
        );
        (uint256 out, bool usedFables) = router.buyWithETH{value: 2 ether}(
            qqq.fablesHopIdx, qqq.ramsesHopIdx, true, qqq.token, address(ballastToken), qqq.hook, 1, block.timestamp + 300
        );
        assertFalse(usedFables, "QQQ at 2 ETH should have fallen back off Fables onto Ramses");
        assertGt(out, 0, "fallback leg produced zero output");
    }

    /// @notice The mirror case: prefer Ramses first, Ramses's own route reverts (force
    ///         it by pointing ramsesHopIdx at a route that does not actually connect
    ///         WETH to the quote asset — BadHopChain), falls back onto Fables.
    function test_fallback_ramsesFirst_fallsBackToFables() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        Ticker memory nvda = _tickers()[0];
        uint256[] memory brokenRamsesPath = _idx1(1); // route 1 is WETH/SPY, not WETH/NVDA
        (uint256 out, bool usedFables) = router.buyWithETH{value: 0.1 ether}(
            nvda.fablesHopIdx, brokenRamsesPath, false, nvda.token, address(ballastToken), nvda.hook, 1, block.timestamp + 300
        );
        assertTrue(usedFables, "should have fallen back onto Fables when the (deliberately wrong) Ramses path failed");
        assertGt(out, 0, "fallback leg produced zero output");
    }

    function test_allVenuesFailed_whenBothPathsAreWrong() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        Ticker memory nvda = _tickers()[0];
        uint256[] memory brokenFablesPath = _idx1(2); // hop 2 is USDG/AAPL, doesn't start at ETH->NVDA's chain
        uint256[] memory brokenRamsesPath = _idx1(1); // WETH/SPY, not WETH/NVDA
        vm.expectRevert(BallastRouterV2.AllVenuesFailed.selector);
        router.buyWithETH{value: 0.1 ether}(
            brokenFablesPath, brokenRamsesPath, true, nvda.token, address(ballastToken), nvda.hook, 1, block.timestamp + 300
        );
    }

    // ===================================================================== //
    //  minOut revert                                                        //
    // ===================================================================== //

    function test_minOutReverts_regardlessOfVenue() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        Ticker memory nvda = _tickers()[0];
        vm.expectRevert(BallastRouterV2.InsufficientOutput.selector);
        router.buyWithETH{value: 0.1 ether}(
            nvda.fablesHopIdx, nvda.ramsesHopIdx, true, nvda.token, address(ballastToken), nvda.hook, type(uint256).max, block.timestamp + 300
        );
    }

    // ===================================================================== //
    //  Exact-output through a single Fables hop                             //
    // ===================================================================== //

    function test_exactOutput_singleFablesHop() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address usdg = deployHelper.USDG();
        uint256 wantOut = 100e6; // 100 USDG (6 decimals)

        (uint256 quotedIn,) = quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: PoolKey({
                    currency0: Currency.wrap(address(0)),
                    currency1: Currency.wrap(usdg),
                    fee: 0x800000,
                    tickSpacing: 10,
                    hooks: IHooks(0x06a889870C8f83640D6816319f72e2aA579b6080)
                }),
                zeroForOne: true,
                exactAmount: uint128(wantOut),
                hookData: bytes("")
            })
        );

        uint256 ethBefore = address(this).balance;
        uint256 usdgBefore = IERC20(usdg).balanceOf(address(this));
        uint256 amountIn = router.swapExactOutputSingleFables{value: quotedIn + quotedIn / 10}(
            0, true, wantOut, quotedIn + quotedIn / 10, block.timestamp + 300
        );

        assertEq(IERC20(usdg).balanceOf(address(this)) - usdgBefore, wantOut, "did not receive exactly amountOut");
        assertLe(amountIn, quotedIn + quotedIn / 10, "spent more than amountInMaximum");
        assertEq(ethBefore - address(this).balance, amountIn, "ETH debited didn't match reported amountIn (dust not refunded correctly)");
        console2.log("exact-output: spent wei for 100 USDG:", amountIn);
    }

    // ===================================================================== //
    //  Gas: new single-unlock path vs the currently-deployed BallastRouter  //
    // ===================================================================== //

    address constant OLD_ROUTER = 0xC422e0a6ca75d1ffAfd77f72b710B2Ef3aeF50e1;

    /// @notice NVDA is the one ticker BOTH routers can run head-to-head: the live
    ///         BallastRouter v1 has it wired (routeIndex 0, WETH/NVDA), and it's one of
    ///         our Fables routes too. Same quote asset, same (mock) ballastToken pool,
    ///         same fork block — the only variable is which router executed the buy.
    function test_gasComparison_buyNvda_newRouterVsOldRouter() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 gasBefore = gasleft();
        router.buyWithETH{value: 0.1 ether}(
            _tickers()[0].fablesHopIdx, _tickers()[0].ramsesHopIdx, true, deployHelper.NVDA(), address(ballastToken), address(0), 1, block.timestamp + 300
        );
        uint256 newRouterGas = gasBefore - gasleft();

        gasBefore = gasleft();
        IBallastRouterV1(OLD_ROUTER).buyWithETH{value: 0.1 ether}(
            deployHelper.NVDA(), 0, address(ballastToken), address(0), 1, block.timestamp + 300
        );
        uint256 oldRouterGas = gasBefore - gasleft();

        console2.log("new router (Fables, single unlock) gas:", newRouterGas);
        console2.log("old router (Ramses leg1 + external UniversalRouter leg2) gas:", oldRouterGas);
        if (newRouterGas < oldRouterGas) {
            console2.log("new router cheaper by:", oldRouterGas - newRouterGas);
        } else {
            console2.log("new router MORE expensive by:", newRouterGas - oldRouterGas);
        }
    }

    receive() external payable {}
}
