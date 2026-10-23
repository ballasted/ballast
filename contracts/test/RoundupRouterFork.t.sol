// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RoundupRouter} from "../src/RoundupRouter.sol";

/// @notice Fork test for RoundupRouter's allowlist gate against the live chain-4663
///         AssetRegistry. The routing adapters (IStockBuyer/IMainSwapRouter) are
///         not built yet (see docs/security/roundups.md), so the stock/main legs
///         are driven by a mock here — the point of THIS test is that the real
///         registry is the allowlist gate. Full routing fork tests come with the
///         adapters. SKIPS unless RH_RPC_URL_PAID is set.
contract RoundupRouterForkTest is Test {
    address constant REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5; // allowlisted stock

    RoundupRouter rr;
    MockBuyer mainR;
    MockBuyer stockB;
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        mainR = new MockBuyer();
        stockB = new MockBuyer();
        rr = new RoundupRouter(REGISTRY, address(mainR), address(stockB));
    }

    /// An unlisted stock reverts against the REAL registry.
    function test_Fork_UnlistedStockReverts() public {
        if (!forked) return;
        address junk = makeAddr("junk");
        vm.deal(address(this), 2 ether);
        vm.expectRevert(abi.encodeWithSelector(RoundupRouter.StockNotAllowed.selector, junk));
        rr.buyWithRoundup{value: 1.05 ether}(makeAddr("tok"), 0, 500, junk, 0, "", "");
    }

    /// SGOV passes the real allowlist gate (the round-up leg then runs via the mock
    /// and the main buy via the mock) — proving registry.isAllowed(SGOV) is true
    /// on-chain and no ETH is stranded.
    function test_Fork_SgovPassesGateNoStuckEth() public {
        if (!forked) return;
        vm.deal(address(this), 2 ether);
        rr.buyWithRoundup{value: 1.05 ether}(makeAddr("tok"), 0, 500, SGOV, 0, "", "");
        assertEq(address(rr).balance, 0, "no ETH stuck");
    }

    receive() external payable {}
}

/// Minimal main-swap / stock-buyer mock: consumes the ETH, reports success.
contract MockBuyer {
    function buy(address, address, uint256, bytes calldata) external payable returns (uint256) {
        return 1;
    }

    function buyStockWithETH(address, address, uint256, bytes calldata) external payable returns (uint256) {
        return 1;
    }
}
