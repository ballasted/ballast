// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";
import {BallastHook, BALLAST_HOOK_FLAGS} from "../src/BallastHook.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {BallastRouter} from "../src/BallastRouter.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

interface IWETH9r {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev Phase 3 fork tests for BallastRouter (design report §9), scoped to a
///      representative subset rather than the full combinatorial matrix —
///      real WETH-quoted buy/sell (ETH and a real ERC20 tokenIn via the
///      curated NVDA/WETH pool), the core revert paths (minOut, deadline,
///      unknown route), and the end-of-call zero-balance invariant. Stock-
///      quoted pool coverage and the full opening-valuation matrix live in
///      BallastGraduateFork.t.sol.
contract BallastRouterForkTest is Test {
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    // Verified on-chain 2026-09-26 (fee()/token0()/token1()) — real Uniswap v3
    // NVDA/WETH pool, $1.27M depth (docs/exit-liquidity-table.md).
    address constant NVDA_WETH_POOL = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    AssetRegistry registry;
    FeeConfig cfg;
    BallastHook hook;
    BallastSeeder seeder;
    BallastFactory factory;
    BallastRouter router;
    address platform = makeAddr("platform");
    address trader = makeAddr("trader");
    bool forked;

    address ballastToken;

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

        address ethFeed = address(new MockEthFeed());
        factory = new BallastFactory(address(registry), WETH, seeder, ethFeed, 24 hours, new address[](0));

        BallastRouter.Route[] memory routes = new BallastRouter.Route[](1);
        routes[0] = BallastRouter.Route({pool: NVDA_WETH_POOL, tokenA: WETH, tokenB: NVDA});
        router = new BallastRouter(UNIVERSAL_ROUTER, PERMIT2, WETH, routes);

        (, address token,) = factory.launch("RouterTest", "RTT", 7 days, "", _one(WETH));
        factory.graduate(token);
        ballastToken = token;

        vm.deal(trader, 100 ether);
        deal(NVDA, trader, 1_000e18);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function test_buyWithETH_intoWethQuotedPool() public {
        if (!forked) return;
        vm.prank(trader);
        uint256 out = router.buyWithETH{value: 1 ether}(WETH, 0, ballastToken, address(hook), 0, block.timestamp + 300);
        assertGt(out, 0, "must receive ballast token");
        assertEq(IERC20(ballastToken).balanceOf(trader), out, "trader received exactly the reported output");
        _assertRouterClean();
    }

    function test_buyWithNVDA_viaCuratedRoute_intoWethQuotedPool() public {
        if (!forked) return;
        vm.startPrank(trader);
        IERC20(NVDA).approve(address(router), 100e18);
        uint256 out = router.buy(NVDA, 100e18, WETH, 0, ballastToken, address(hook), 0, block.timestamp + 300);
        vm.stopPrank();
        assertGt(out, 0, "must receive ballast token via NVDA->WETH->token");
        _assertRouterClean();
    }

    /// @notice The exact path $BALLAST v2 needs tonight: ETH -> WETH -> (curated
    ///         NVDA/WETH pool) -> NVDA-quoted Ballast pool. setUp()'s shared
    ///         `factory`/`registry` deliberately don't allow NVDA as a quote
    ///         asset (existing WETH-only coverage above) — build the
    ///         NVDA-aware factory here instead of assuming the WETH-quoted
    ///         proof above generalizes.
    function test_buyWithETH_intoNvdaQuotedPool() public {
        if (!forked) return;
        address nvdaFeed = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15; // real Chainlink NVDA/USD, live-verified 2026-09-26
        registry.setAsset(NVDA, nvdaFeed, 96 hours, 1e17);

        address[] memory green = new address[](1);
        green[0] = NVDA;
        BallastFactory nvdaFactory =
            new BallastFactory(address(registry), WETH, seeder, address(new MockEthFeed()), 24 hours, green);

        (, address token,) = nvdaFactory.launch("RouterTestNVDA", "RTN", 7 days, "", _one(NVDA));
        nvdaFactory.graduate(token);

        vm.prank(trader);
        uint256 out = router.buyWithETH{value: 1 ether}(NVDA, 0, token, address(hook), 0, block.timestamp + 300);
        assertGt(out, 0, "must receive ballast token via ETH->WETH->NVDA(pool)->NVDA-quoted-token");
        assertEq(IERC20(token).balanceOf(trader), out, "trader received exactly the reported output");
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "router must hold zero WETH after a call");
        assertEq(IERC20(NVDA).balanceOf(address(router)), 0, "router must hold zero NVDA after a call");
        assertEq(IERC20(token).balanceOf(address(router)), 0, "router must hold zero of the new token after a call");
        assertEq(address(router).balance, 0, "router must hold zero ETH after a call");
    }

    function test_sellToETH_afterBuy() public {
        if (!forked) return;
        vm.startPrank(trader);
        uint256 bought = router.buyWithETH{value: 1 ether}(WETH, 0, ballastToken, address(hook), 0, block.timestamp + 300);
        IERC20(ballastToken).approve(address(router), bought);
        uint256 ethBefore = trader.balance;
        uint256 out = router.sellToETH(ballastToken, bought, WETH, address(hook), 0, 0, block.timestamp + 300);
        vm.stopPrank();
        assertGt(out, 0, "must receive ETH");
        assertEq(trader.balance - ethBefore, out, "trader received exactly the reported ETH output");
        _assertRouterClean();
    }

    function test_buy_impossibleMinOut_reverts() public {
        if (!forked) return;
        vm.prank(trader);
        vm.expectRevert(BallastRouter.InsufficientOutput.selector);
        router.buyWithETH{value: 1 ether}(WETH, 0, ballastToken, address(hook), type(uint256).max, block.timestamp + 300);
    }

    function test_buy_expiredDeadline_reverts() public {
        if (!forked) return;
        vm.warp(block.timestamp + 1000);
        vm.prank(trader);
        vm.expectRevert(BallastRouter.DeadlineExpired.selector);
        router.buyWithETH{value: 1 ether}(WETH, 0, ballastToken, address(hook), 0, block.timestamp - 1);
    }

    function test_buy_unknownRouteIndex_reverts() public {
        if (!forked) return;
        vm.startPrank(trader);
        IERC20(NVDA).approve(address(router), 100e18);
        vm.expectRevert(); // out-of-bounds array access — no route[1] exists
        router.buy(NVDA, 100e18, WETH, 1, ballastToken, address(hook), 0, block.timestamp + 300);
        vm.stopPrank();
    }

    function test_buy_routeIndexPointsToWrongPair_reverts() public {
        if (!forked) return;
        // routes[0] is WETH<->NVDA; asking it to serve a WETH<->WETH "swap"
        // (quoteAsset==tokenIn would never call _swapDirect at all, so instead
        // exercise the real mismatch: claim tokenIn=NVDA but request quoteAsset
        // that isn't NVDA against the same route).
        vm.startPrank(trader);
        IERC20(NVDA).approve(address(router), 100e18);
        vm.expectRevert(BallastRouter.UnknownRoute.selector);
        router.buy(NVDA, 100e18, address(0xdead), 0, ballastToken, address(hook), 0, block.timestamp + 300);
        vm.stopPrank();
    }

    function _assertRouterClean() internal view {
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "router must hold zero WETH after a call");
        assertEq(IERC20(NVDA).balanceOf(address(router)), 0, "router must hold zero NVDA after a call");
        assertEq(IERC20(ballastToken).balanceOf(address(router)), 0, "router must hold zero ballast token after a call");
        assertEq(address(router).balance, 0, "router must hold zero ETH after a call");
    }
}

contract MockEthFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 3000e8, block.timestamp, block.timestamp, 1);
    }
}
