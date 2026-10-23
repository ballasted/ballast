// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RoundupRouter} from "../src/RoundupRouter.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract MockRegistry {
    mapping(address => bool) public allowed;

    function setAllowed(address a, bool v) external {
        allowed[a] = v;
    }

    function isAllowed(address a) external view returns (bool) {
        return allowed[a];
    }
}

// Delivers `stockOut` of a mock stock to recipient, or reverts when `fail` is set.
contract MockStockBuyer {
    MockERC20 public immutable stockToken;
    bool public fail;
    uint256 public outAmount = 44 ether;

    constructor(MockERC20 s) {
        stockToken = s;
    }

    function setFail(bool f) external {
        fail = f;
    }

    function buyStockWithETH(address, address recipient, uint256, bytes calldata) external payable returns (uint256) {
        require(!fail, "route failed");
        stockToken.mint(recipient, outAmount);
        // keep the ETH (simulates spending it on the route)
        return outAmount;
    }
}

// Buy: mints `token` to trader, consumes the ETH. Sell: pulls token, pays ETH back.
contract MockMainRouter {
    MockERC20 public immutable tok;
    uint256 public buyOut = 1_000 ether;
    uint256 public sellEthOut = 1 ether;

    constructor(MockERC20 t) {
        tok = t;
    }
    receive() external payable {}

    function buy(address, address trader, uint256, bytes calldata) external payable returns (uint256) {
        tok.mint(trader, buyOut);
        return buyOut;
    }

    function sell(address token, address, uint256 amountIn, uint256, bytes calldata) external returns (uint256) {
        MockERC20(token).transferFrom(msg.sender, address(this), amountIn);
        (bool ok,) = msg.sender.call{value: sellEthOut}("");
        require(ok, "eth");
        return sellEthOut;
    }
}

// Re-enters buyWithRoundup during the round-up leg to prove the guard holds.
contract ReentrantStockBuyer {
    RoundupRouter public rr;
    address public token;

    function arm(RoundupRouter r, address t) external {
        rr = r;
        token = t;
    }

    function buyStockWithETH(address, address, uint256, bytes calldata) external payable returns (uint256) {
        rr.buyWithRoundup{value: 1}(token, 0, 0, address(0), 0, "", "");
        return 1;
    }
}

contract RoundupRouterTest is Test {
    RoundupRouter rr;
    MockRegistry reg;
    MockMainRouter mainR;
    MockStockBuyer stockB;
    MockERC20 token;
    MockERC20 stockTok;
    address NVDA = makeAddr("NVDA");
    address trader = makeAddr("trader");

    function setUp() public {
        reg = new MockRegistry();
        token = new MockERC20();
        stockTok = new MockERC20();
        mainR = new MockMainRouter(token);
        stockB = new MockStockBuyer(stockTok);
        rr = new RoundupRouter(address(reg), address(mainR), address(stockB));
        reg.setAllowed(NVDA, true);
        vm.deal(address(mainR), 100 ether); // fund the sell payouts
        vm.deal(trader, 100 ether);
    }

    function _noStuck() internal view {
        assertEq(address(rr).balance, 0, "no ETH stuck in RoundupRouter");
    }

    // ── buy ──

    function test_BuyWithRoundupSuccess() public {
        vm.prank(trader);
        rr.buyWithRoundup{value: 1.05 ether}(address(token), 0, 500, NVDA, 0, "", "");
        assertEq(token.balanceOf(trader), mainR.buyOut(), "trader got the main token");
        assertEq(stockTok.balanceOf(trader), stockB.outAmount(), "trader got the round-up stock");
        _noStuck();
    }

    function test_BuyNoRoundupWhenBpsZero() public {
        vm.prank(trader);
        rr.buyWithRoundup{value: 1 ether}(address(token), 0, 0, address(0), 0, "", "");
        assertEq(stockTok.balanceOf(trader), 0);
        assertGt(token.balanceOf(trader), 0);
        _noStuck();
    }

    function test_FailedRoundupRefundsAndMainStillRuns() public {
        stockB.setFail(true);
        uint256 balBefore = trader.balance;
        vm.prank(trader);
        rr.buyWithRoundup{value: 1.05 ether}(address(token), 0, 500, NVDA, 0, "", "");
        // Main swap still happened...
        assertEq(token.balanceOf(trader), mainR.buyOut());
        // ...no stock...
        assertEq(stockTok.balanceOf(trader), 0);
        // ...and the round-up ETH (0.05 of 1.05) was refunded (trader only spent the 1.0 main leg).
        assertEq(trader.balance, balBefore - 1 ether, "round-up ETH refunded");
        _noStuck();
    }

    function test_RevertRoundupBpsTooHigh() public {
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(RoundupRouter.RoundupBpsTooHigh.selector, 501));
        rr.buyWithRoundup{value: 1 ether}(address(token), 0, 501, NVDA, 0, "", "");
    }

    function test_RevertUnlistedStock() public {
        address bad = makeAddr("bad");
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(RoundupRouter.StockNotAllowed.selector, bad));
        rr.buyWithRoundup{value: 1.05 ether}(address(token), 0, 500, bad, 0, "", "");
    }

    function test_RevertZeroEth() public {
        vm.prank(trader);
        vm.expectRevert(RoundupRouter.ZeroEthIn.selector);
        rr.buyWithRoundup{value: 0}(address(token), 0, 0, address(0), 0, "", "");
    }

    function test_Reentrancy() public {
        // The round-up leg is try/catch, so a reentrant stock buyer's nested call is
        // blocked by the guard and the leg simply FAILS (caught) — the main swap still
        // runs and no funds are stranded. This proves the guard prevents nested state
        // changes without bricking the outer call.
        ReentrantStockBuyer evil = new ReentrantStockBuyer();
        RoundupRouter rr2 = new RoundupRouter(address(reg), address(mainR), address(evil));
        evil.arm(rr2, address(token));
        vm.deal(trader, 10 ether);
        uint256 balBefore = trader.balance;
        vm.prank(trader);
        rr2.buyWithRoundup{value: 1.05 ether}(address(token), 0, 500, NVDA, 0, "", "");
        assertEq(token.balanceOf(trader), mainR.buyOut(), "main swap still ran");
        assertEq(stockTok.balanceOf(trader), 0, "reentrant round-up leg was blocked");
        assertEq(trader.balance, balBefore - 1 ether, "round-up ETH refunded after the blocked leg");
        assertEq(address(rr2).balance, 0, "no funds stranded");
    }

    // ── sell ──

    function test_SellWithRoundupSuccess() public {
        token.mint(trader, 1000 ether);
        vm.prank(trader);
        token.approve(address(rr), type(uint256).max);
        uint256 balBefore = trader.balance;
        vm.prank(trader);
        rr.sellWithRoundup(address(token), 1000 ether, 0, 500, NVDA, 0, "", "");
        assertEq(stockTok.balanceOf(trader), stockB.outAmount(), "trader got round-up stock");
        // ETH out = 1 ether; 5% (0.05) spent on round-up, 0.95 to trader.
        assertEq(trader.balance, balBefore + 0.95 ether, "trader got net ETH");
        _noStuck();
    }

    function test_SellFailedRoundupFoldsBack() public {
        stockB.setFail(true);
        token.mint(trader, 1000 ether);
        vm.prank(trader);
        token.approve(address(rr), type(uint256).max);
        uint256 balBefore = trader.balance;
        vm.prank(trader);
        rr.sellWithRoundup(address(token), 1000 ether, 0, 500, NVDA, 0, "", "");
        assertEq(stockTok.balanceOf(trader), 0);
        // round-up folded back -> trader gets the full 1 ether.
        assertEq(trader.balance, balBefore + 1 ether, "round-up folded into payout");
        _noStuck();
    }
}
