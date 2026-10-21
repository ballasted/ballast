// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BurnVote} from "../src/BurnVote.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

// ── Minimal mocks ────────────────────────────────────────────────────────────
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) public returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) public virtual returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

// Re-enters BurnVote.vote during transferFrom to prove the reentrancy guard holds.
contract ReentrantToken is MockERC20 {
    BurnVote public bv;
    address public stock;
    bool armed;

    function arm(BurnVote b, address s) external {
        bv = b;
        stock = s;
        armed = true;
    }

    function transferFrom(address f, address to, uint256 a) public override returns (bool) {
        if (armed) {
            armed = false;
            bv.vote(address(this), stock, 1);
        }
        return super.transferFrom(f, to, a);
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

contract MockFactory {
    mapping(address => uint256) public launchIdOf;

    function setLaunch(address token, uint256 idPlus1) external {
        launchIdOf[token] = idPlus1;
    }
}

contract BurnVoteTest is Test {
    BurnVote bv;
    MockRegistry reg;
    MockFactory fac;
    MockERC20 token;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address NVDA = makeAddr("NVDA");
    address SPY = makeAddr("SPY");
    address SGOV = makeAddr("SGOV");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant GENESIS = 1_704_067_200;
    uint256 constant WEEK = 7 days;

    function setUp() public {
        reg = new MockRegistry();
        fac = new MockFactory();
        address[] memory facs = new address[](1);
        facs[0] = address(fac);
        bv = new BurnVote(address(reg), facs);

        token = new MockERC20();
        fac.setLaunch(address(token), 1); // token is Ballast-launched
        reg.setAllowed(NVDA, true);
        reg.setAllowed(SPY, true);
        reg.setAllowed(SGOV, true);

        token.mint(alice, 1_000_000 ether);
        token.mint(bob, 1_000_000 ether);
        vm.prank(alice);
        token.approve(address(bv), type(uint256).max);
        vm.prank(bob);
        token.approve(address(bv), type(uint256).max);

        _warpToEpoch(100); // start well after genesis
    }

    function _warpToEpoch(uint256 e) internal {
        vm.warp(GENESIS + e * WEEK + 1);
    }

    function _epochStart(uint256 e) internal pure returns (uint256) {
        return GENESIS + e * WEEK;
    }

    // ── adversarial / validation ──

    function test_RevertNonBallastToken() public {
        MockERC20 notBallast = new MockERC20();
        notBallast.mint(alice, 1 ether);
        vm.prank(alice);
        notBallast.approve(address(bv), 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnVote.NotBallastToken.selector, address(notBallast)));
        bv.vote(address(notBallast), NVDA, 1 ether);
    }

    function test_RevertStockNotAllowed() public {
        address bad = address(0xBAD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnVote.StockNotAllowed.selector, bad));
        bv.vote(address(token), bad, 1 ether);
    }

    function test_RevertZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(BurnVote.ZeroAmount.selector);
        bv.vote(address(token), NVDA, 0);
    }

    function test_RevertSelfVote() public {
        reg.setAllowed(address(token), true);
        vm.prank(alice);
        vm.expectRevert(BurnVote.SelfVote.selector);
        bv.vote(address(token), address(token), 1 ether);
    }

    function test_ReentrancyGuard() public {
        ReentrantToken rt = new ReentrantToken();
        fac.setLaunch(address(rt), 1);
        rt.mint(alice, 10 ether);
        vm.prank(alice);
        rt.approve(address(bv), type(uint256).max);
        rt.arm(bv, NVDA);
        vm.prank(alice);
        vm.expectRevert(); // ReentrancyGuard: reentrant call
        bv.vote(address(rt), NVDA, 1 ether);
    }

    // ── votes reach the dead address ──

    function test_VotesBurnToDead() public {
        uint256 before = token.balanceOf(DEAD);
        vm.prank(alice);
        bv.vote(address(token), NVDA, 100 ether);
        assertEq(token.balanceOf(DEAD), before + 100 ether);
        assertEq(token.balanceOf(address(bv)), 0, "contract holds nothing");
        assertEq(bv.tally(address(token), bv.currentEpoch(), NVDA), 100 ether);
    }

    // ── winners / ties / carry-over ──

    function test_UniqueWinnerBecomesDefault() public {
        uint256 e = bv.currentEpoch();
        vm.prank(alice);
        bv.vote(address(token), NVDA, 100 ether);
        vm.prank(bob);
        bv.vote(address(token), SPY, 40 ether);
        // still current epoch -> not yet the default
        assertEq(bv.defaultStock(address(token)), address(0));
        _warpToEpoch(e + 1);
        assertEq(bv.defaultStock(address(token)), NVDA);
    }

    function test_TieLeavesDefaultUnchanged() public {
        uint256 e = bv.currentEpoch();
        // epoch e: NVDA wins uniquely
        vm.prank(alice);
        bv.vote(address(token), NVDA, 100 ether);
        _warpToEpoch(e + 1);
        assertEq(bv.defaultStock(address(token)), NVDA);
        // epoch e+1: a tie NVDA vs SPY -> default stays NVDA
        vm.prank(alice);
        bv.vote(address(token), SPY, 50 ether);
        vm.prank(bob);
        bv.vote(address(token), SGOV, 50 ether);
        _warpToEpoch(e + 2);
        assertEq(bv.defaultStock(address(token)), NVDA, "tie keeps prior default");
    }

    function test_EmptyEpochCarriesOver() public {
        uint256 e = bv.currentEpoch();
        vm.prank(alice);
        bv.vote(address(token), SPY, 10 ether);
        _warpToEpoch(e + 5); // several empty epochs pass
        assertEq(bv.defaultStock(address(token)), SPY);
    }

    function test_NeverWinnerNoDefault() public {
        assertEq(bv.defaultStock(address(token)), address(0));
    }

    function test_LaterUniqueWinnerOverrides() public {
        uint256 e = bv.currentEpoch();
        vm.prank(alice);
        bv.vote(address(token), NVDA, 100 ether);
        _warpToEpoch(e + 1);
        vm.prank(alice);
        bv.vote(address(token), SPY, 100 ether);
        _warpToEpoch(e + 2);
        assertEq(bv.defaultStock(address(token)), SPY);
    }

    // ── long gaps + finalize ──

    function test_LongGapThenFinalize() public {
        uint256 e = bv.currentEpoch();
        vm.prank(alice);
        bv.vote(address(token), NVDA, 100 ether);
        _warpToEpoch(e + 300); // ~6 years later
        // view is correct without any finalize
        assertEq(bv.defaultStock(address(token)), NVDA);
        bv.finalize(address(token));
        assertEq(bv.defaultStock(address(token)), NVDA);
        // finalize is idempotent
        bv.finalize(address(token));
        assertEq(bv.defaultStock(address(token)), NVDA);
    }

    function test_FinalizeMatchesLazyView() public {
        uint256 e = bv.currentEpoch();
        vm.prank(alice);
        bv.vote(address(token), NVDA, 100 ether);
        _warpToEpoch(e + 1);
        vm.prank(alice); // SPY uniquely wins e+1
        bv.vote(address(token), SPY, 10 ether);
        _warpToEpoch(e + 2);
        address lazy = bv.defaultStock(address(token));
        bv.finalize(address(token));
        assertEq(bv.defaultStock(address(token)), lazy);
        assertEq(lazy, SPY);
    }

    // ── views ──

    function test_TimeLeftAndEpochTallies() public {
        uint256 e = bv.currentEpoch();
        vm.warp(_epochStart(e) + 1);
        assertApproxEqAbs(bv.timeLeftInEpoch(), WEEK, 2);
        vm.prank(alice);
        bv.vote(address(token), NVDA, 7 ether);
        vm.prank(bob);
        bv.vote(address(token), SPY, 3 ether);
        (address[] memory stocks, uint256[] memory votes) = bv.epochTallies(address(token), e);
        assertEq(stocks.length, 2);
        assertEq(votes[0], 7 ether);
        assertEq(votes[1], 3 ether);
        (address leader, uint256 v) = bv.currentLeader(address(token));
        assertEq(leader, NVDA);
        assertEq(v, 7 ether);
    }
}
