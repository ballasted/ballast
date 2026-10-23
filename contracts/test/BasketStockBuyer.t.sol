// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BasketStockBuyer} from "../src/BasketStockBuyer.sol";

/// @dev Minimal AssetRegistry stand-in — BasketStockBuyer only ever calls
///      `isAllowed(address)`. Per-asset allow flag so a test can list/de-list a
///      stock and prove the gate reacts (the "stock removed from AssetRegistry"
///      edge case).
contract MockRegistry {
    mapping(address => bool) public allowed;

    function setAllowed(address asset, bool v) external {
        allowed[asset] = v;
    }

    function isAllowed(address asset) external view returns (bool) {
        return allowed[asset];
    }
}

/// @notice Deterministic UNIT tests for BasketStockBuyer's input validation and
///         constructor guards — the paths that run BEFORE any pool interaction,
///         so they need no fork/RPC (the live swap paths are covered by
///         BasketStockBuyerFork.t.sol). Adversarial-first per CLAUDE.md: every
///         revert the trader-facing entrypoint must enforce is pinned here.
contract BasketStockBuyerUnitTest is Test {
    BasketStockBuyer buyer;
    MockRegistry registry;

    address constant POOL_MANAGER = address(0xBEEF); // never called on these paths
    address constant WETH = address(0xE7); // non-zero dummy; the WETH path isn't exercised in unit tests
    address stock = makeAddr("stock");
    address recipient = makeAddr("recipient");

    function setUp() public {
        registry = new MockRegistry();
        BasketStockBuyer.FablesHop[] memory hops = new BasketStockBuyer.FablesHop[](0);
        BasketStockBuyer.RamsesRoute[] memory routes = new BasketStockBuyer.RamsesRoute[](0);
        buyer = new BasketStockBuyer(address(registry), IPoolManager(POOL_MANAGER), WETH, hops, routes);
        registry.setAllowed(stock, true);
        vm.deal(address(this), 100 ether);
        vm.warp(1_000_000);
    }

    // route = abi.encode(uint256[] fablesHopIdx, uint256[] ramsesHopIdx, bool preferFables, uint256 deadline)
    function _route(uint256 deadline) internal pure returns (bytes memory) {
        return abi.encode(new uint256[](0), new uint256[](0), true, deadline);
    }

    function _future() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    // ── constructor guards ──

    function test_Constructor_RevertZeroRegistry() public {
        BasketStockBuyer.FablesHop[] memory h = new BasketStockBuyer.FablesHop[](0);
        BasketStockBuyer.RamsesRoute[] memory r = new BasketStockBuyer.RamsesRoute[](0);
        vm.expectRevert(BasketStockBuyer.ZeroAddress.selector);
        new BasketStockBuyer(address(0), IPoolManager(POOL_MANAGER), WETH, h, r);
    }

    function test_Constructor_RevertZeroWeth() public {
        BasketStockBuyer.FablesHop[] memory h = new BasketStockBuyer.FablesHop[](0);
        BasketStockBuyer.RamsesRoute[] memory r = new BasketStockBuyer.RamsesRoute[](0);
        vm.expectRevert(BasketStockBuyer.ZeroAddress.selector);
        new BasketStockBuyer(address(registry), IPoolManager(POOL_MANAGER), address(0), h, r);
    }

    function test_Constructor_RevertZeroPoolManager() public {
        BasketStockBuyer.FablesHop[] memory h = new BasketStockBuyer.FablesHop[](0);
        BasketStockBuyer.RamsesRoute[] memory r = new BasketStockBuyer.RamsesRoute[](0);
        vm.expectRevert(BasketStockBuyer.ZeroAddress.selector);
        new BasketStockBuyer(address(registry), IPoolManager(address(0)), WETH, h, r);
    }

    // ── buyStockWithETH input validation (all fire before any swap) ──

    function test_RevertWhen_ZeroEthIn() public {
        vm.expectRevert(BasketStockBuyer.ZeroEthIn.selector);
        buyer.buyStockWithETH{value: 0}(stock, recipient, 1, _route(_future()));
    }

    function test_RevertWhen_ZeroRecipient() public {
        vm.expectRevert(BasketStockBuyer.ZeroAddress.selector);
        buyer.buyStockWithETH{value: 1 ether}(stock, address(0), 1, _route(_future()));
    }

    function test_RevertWhen_ZeroStock() public {
        vm.expectRevert(BasketStockBuyer.ZeroAddress.selector);
        buyer.buyStockWithETH{value: 1 ether}(address(0), recipient, 1, _route(_future()));
    }

    function test_RevertWhen_ZeroMinOut() public {
        vm.expectRevert(BasketStockBuyer.MinOutTooLow.selector);
        buyer.buyStockWithETH{value: 1 ether}(stock, recipient, 0, _route(_future()));
    }

    function test_RevertWhen_StockNotAllowed() public {
        address notListed = makeAddr("notListed");
        vm.expectRevert(abi.encodeWithSelector(BasketStockBuyer.StockNotAllowed.selector, notListed));
        buyer.buyStockWithETH{value: 1 ether}(notListed, recipient, 1, _route(_future()));
    }

    /// A stock that WAS listed then removed from the registry must stop being buyable.
    function test_RevertWhen_StockRemovedFromRegistry() public {
        registry.setAllowed(stock, false);
        vm.expectRevert(abi.encodeWithSelector(BasketStockBuyer.StockNotAllowed.selector, stock));
        buyer.buyStockWithETH{value: 1 ether}(stock, recipient, 1, _route(_future()));
    }

    function test_RevertWhen_DeadlinePassed() public {
        uint256 past = block.timestamp - 1;
        vm.expectRevert(BasketStockBuyer.DeadlinePassed.selector);
        buyer.buyStockWithETH{value: 1 ether}(stock, recipient, 1, _route(past));
    }

    // ── sanity: no owner, immutable config ──

    function test_NoOwnerOrAdminSurface() public view {
        // Empty routing tables as constructed; no setter exists to change them.
        assertEq(buyer.fablesHopsLength(), 0);
        assertEq(buyer.ramsesRoutesLength(), 0);
        assertEq(address(buyer.registry()), address(registry));
        assertEq(buyer.weth(), WETH);
    }
}
