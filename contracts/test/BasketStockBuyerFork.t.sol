// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BasketStockBuyer} from "../src/BasketStockBuyer.sol";
import {BasketZap} from "../src/BasketZap.sol";
import {DeployBasketZap} from "../script/DeployBasketZap.s.sol";

/// @notice Fork test for the RoundupRouter stock-buyer adapter against live chain
///         4663. Exercises ETH -> stock -> recipient for each routable stock, plus
///         slippage (minStockOut), an unlisted stock, and no-leftover-ETH. Uses the
///         SAME verified Fables/Ramses tables DeployBasketZap deploys.
///
///         SKIPS unless RH_RPC_URL_PAID is set (same pattern as BasketZapFork.t.sol:
///         the human/CI runs the fork; the sandbox skips). This is the required
///         pre-deploy verification for BasketStockBuyer — see docs/security/roundups.md.
contract BasketStockBuyerForkTest is Test {
    BasketStockBuyer buyer;
    bool forked;
    address trader = makeAddr("trader");

    // Routable GREEN stocks + their fixed hop indices (from DeployBasketZap's maps).
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        DeployBasketZap cfg = new DeployBasketZap();
        BasketZap.FablesHop[] memory zf = cfg.buildFablesHops();
        BasketZap.RamsesRoute[] memory zr = cfg.buildRamsesRoutes();
        BasketStockBuyer.FablesHop[] memory hops = new BasketStockBuyer.FablesHop[](zf.length);
        for (uint256 i = 0; i < zf.length; i++) {
            hops[i] =
                BasketStockBuyer.FablesHop(zf[i].currency0, zf[i].currency1, zf[i].fee, zf[i].tickSpacing, zf[i].hooks);
        }
        BasketStockBuyer.RamsesRoute[] memory routes = new BasketStockBuyer.RamsesRoute[](zr.length);
        for (uint256 i = 0; i < zr.length; i++) {
            routes[i] = BasketStockBuyer.RamsesRoute(zr[i].pool, zr[i].tokenA, zr[i].tokenB);
        }
        buyer = new BasketStockBuyer(cfg.REGISTRY(), IPoolManager(cfg.POOL_MANAGER()), cfg.WETH(), hops, routes);
    }

    function _route(uint256[] memory fables, uint256[] memory ramses, bool preferFables)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(fables, ramses, preferFables, block.timestamp + 300);
    }

    function _idx1(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _idx2(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }

    function _buy(address stock, uint256[] memory fables, uint256[] memory ramses, bool preferFables) internal {
        uint256 before = IERC20(stock).balanceOf(trader);
        vm.deal(address(this), 1 ether);
        uint256 out = buyer.buyStockWithETH{value: 0.01 ether}(stock, trader, 1, _route(fables, ramses, preferFables));
        assertGt(out, 0, "stock delivered");
        assertEq(IERC20(stock).balanceOf(trader) - before, out, "trader received exactly out");
        assertEq(address(buyer).balance, 0, "no ETH stranded in buyer");
    }

    function test_Fork_BuyNVDA() public {
        if (!forked) return;
        _buy(NVDA, _idx2(0, 1), _idx1(0), false); // Ramses [0]
    }

    function test_Fork_BuySPY() public {
        if (!forked) return;
        _buy(SPY, _idx2(0, 10), _idx1(1), false); // Ramses [1]
    }

    function test_Fork_BuySGOV() public {
        if (!forked) return;
        _buy(SGOV, new uint256[](0), _idx2(4, 12), false); // Ramses [4,12] bridge via WETH/USDG
    }

    function test_Fork_SlippageReverts() public {
        if (!forked) return;
        vm.deal(address(this), 1 ether);
        vm.expectRevert(); // minStockOut unreachably high -> InsufficientOutput
        buyer.buyStockWithETH{value: 0.01 ether}(NVDA, trader, type(uint256).max, _route(_idx2(0, 1), _idx1(0), false));
        assertEq(address(buyer).balance, 0, "no ETH stranded on revert");
    }

    function test_Fork_UnlistedReverts() public {
        if (!forked) return;
        address junk = makeAddr("junk");
        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(BasketStockBuyer.StockNotAllowed.selector, junk));
        buyer.buyStockWithETH{value: 0.01 ether}(junk, trader, 1, _route(new uint256[](0), _idx1(0), false));
    }

    receive() external payable {}
}
