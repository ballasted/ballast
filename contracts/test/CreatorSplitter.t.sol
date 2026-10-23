// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreatorSplitter} from "../src/CreatorSplitter.sol";
import {CreatorSplitterFactory} from "../src/CreatorSplitterFactory.sol";

// Standard-ish ERC20.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

// Non-standard ERC20: transfer returns NOTHING (like USDT). SafeERC20 must cope.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }
}

// Reentrant ETH recipient: tries to re-enter release() on receipt.
contract ReentrantRecipient {
    CreatorSplitter public s;
    bool armed;

    function arm(CreatorSplitter s_) external {
        s = s_;
        armed = true;
    }

    receive() external payable {
        if (armed) {
            armed = false;
            // Re-enter: must not let it double-withdraw.
            try s.release(address(0), address(this)) {} catch {}
        }
    }
}

// Rejects ETH always — proves pull-based isolation (one bad recipient can't block others).
contract RejectEth {
    receive() external payable {
        revert("no eth");
    }
}

contract CreatorSplitterTest is Test {
    CreatorSplitterFactory factory;
    address a = makeAddr("a");
    address b = makeAddr("b");
    address c = makeAddr("c");

    function setUp() public {
        factory = new CreatorSplitterFactory();
    }

    function _mk(address[] memory rs, uint16[] memory ss) internal returns (CreatorSplitter) {
        return factory.create(rs, ss);
    }

    function _two(address r0, uint16 s0, address r1, uint16 s1)
        internal
        pure
        returns (address[] memory rs, uint16[] memory ss)
    {
        rs = new address[](2);
        ss = new uint16[](2);
        rs[0] = r0;
        rs[1] = r1;
        ss[0] = s0;
        ss[1] = s1;
    }

    // ── adversarial / constructor validation ──

    function test_RevertZeroRecipients() public {
        address[] memory rs = new address[](0);
        uint16[] memory ss = new uint16[](0);
        vm.expectRevert(abi.encodeWithSelector(CreatorSplitter.BadRecipientCount.selector, 0));
        _mk(rs, ss);
    }

    function test_RevertTooManyRecipients() public {
        address[] memory rs = new address[](5);
        uint16[] memory ss = new uint16[](5);
        for (uint256 i; i < 5; ++i) {
            rs[i] = address(uint160(i + 1));
            ss[i] = 2000;
        }
        vm.expectRevert(abi.encodeWithSelector(CreatorSplitter.BadRecipientCount.selector, 5));
        _mk(rs, ss);
    }

    function test_RevertSharesDontSum() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, b, 4000);
        vm.expectRevert(abi.encodeWithSelector(CreatorSplitter.SharesMustSumToBps.selector, 9000));
        _mk(rs, ss);
    }

    function test_RevertZeroAddress() public {
        (address[] memory rs, uint16[] memory ss) = _two(address(0), 5000, b, 5000);
        vm.expectRevert(CreatorSplitter.ZeroAddress.selector);
        _mk(rs, ss);
    }

    function test_RevertZeroShare() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 0, b, 10000);
        vm.expectRevert(CreatorSplitter.ZeroShare.selector);
        _mk(rs, ss);
    }

    function test_RevertDuplicateRecipient() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, a, 5000);
        vm.expectRevert(abi.encodeWithSelector(CreatorSplitter.DuplicateRecipient.selector, a));
        _mk(rs, ss);
    }

    function test_RevertReleaseToNonRecipient() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, b, 5000);
        CreatorSplitter s = _mk(rs, ss);
        vm.deal(address(s), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(CreatorSplitter.NotARecipient.selector, c));
        s.release(address(0), c);
    }

    function test_RevertNothingToRelease() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, b, 5000);
        CreatorSplitter s = _mk(rs, ss);
        vm.expectRevert(abi.encodeWithSelector(CreatorSplitter.NothingToRelease.selector, address(0), a));
        s.release(address(0), a);
    }

    // ── ETH happy path ──

    function test_EthSplit() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 7000, b, 3000);
        CreatorSplitter s = _mk(rs, ss);
        vm.deal(address(s), 10 ether);
        s.releaseAll(address(0));
        assertEq(a.balance, 7 ether);
        assertEq(b.balance, 3 ether);
        assertEq(address(s).balance, 0);
        assertEq(s.totalReleased(address(0)), 10 ether);
    }

    // ── ERC20 happy path ──

    function test_Erc20Split() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 6000, b, 4000);
        CreatorSplitter s = _mk(rs, ss);
        MockERC20 t = new MockERC20();
        t.mint(address(s), 1000e18);
        s.releaseAll(address(t));
        assertEq(t.balanceOf(a), 600e18);
        assertEq(t.balanceOf(b), 400e18);
    }

    // ── non-standard ERC20 (no return value) ──

    function test_NoReturnErc20() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, b, 5000);
        CreatorSplitter s = _mk(rs, ss);
        NoReturnERC20 t = new NoReturnERC20();
        t.mint(address(s), 100e18);
        s.release(address(t), a);
        s.release(address(t), b);
        assertEq(t.balanceOf(a), 50e18);
        assertEq(t.balanceOf(b), 50e18);
    }

    // ── rounding / dust: 1/3 splits of an indivisible amount ──

    function test_RoundingDustBounded() public {
        address[] memory rs = new address[](3);
        uint16[] memory ss = new uint16[](3);
        rs[0] = a;
        rs[1] = b;
        rs[2] = c;
        ss[0] = 3333;
        ss[1] = 3333;
        ss[2] = 3334;
        CreatorSplitter s = _mk(rs, ss);
        vm.deal(address(s), 100); // tiny, indivisible
        s.releaseAll(address(0));
        uint256 paid = a.balance + b.balance + c.balance;
        // Never over-pays; leftover dust < number of recipients and stays in the contract.
        assertLe(paid, 100);
        assertLt(100 - paid, 3);
        assertEq(address(s).balance, 100 - paid);
    }

    // ── many small payments accumulate correctly ──

    function test_ManySmallPayments() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, b, 5000);
        CreatorSplitter s = _mk(rs, ss);
        for (uint256 i; i < 20; ++i) {
            vm.deal(address(s), address(s).balance + 1 ether);
            s.releaseAll(address(0));
        }
        assertEq(a.balance, 10 ether);
        assertEq(b.balance, 10 ether);
        assertEq(address(s).balance, 0);
    }

    // ── one recipient rejecting ETH never blocks the other ──

    function test_RejectingRecipientDoesNotBlockOthers() public {
        RejectEth bad = new RejectEth();
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, address(bad), 5000);
        CreatorSplitter s = _mk(rs, ss);
        vm.deal(address(s), 10 ether);
        // releaseAll would revert on `bad` (its receive reverts). Pull a: unaffected.
        s.release(address(0), a);
        assertEq(a.balance, 5 ether);
        // bad's share stays owed, recoverable if it later becomes able to receive.
        assertEq(s.releasable(address(0), address(bad)), 5 ether);
    }

    // ── reentrancy: can't double-withdraw ──

    function test_ReentrancyNoDoubleWithdraw() public {
        ReentrantRecipient evil = new ReentrantRecipient();
        (address[] memory rs, uint16[] memory ss) = _two(address(evil), 5000, b, 5000);
        CreatorSplitter s = _mk(rs, ss);
        evil.arm(s);
        vm.deal(address(s), 10 ether);
        s.release(address(0), address(evil));
        assertEq(address(evil).balance, 5 ether, "exactly its share, no double");
        assertEq(s.releasable(address(0), address(evil)), 0);
    }

    // ── factory bookkeeping ──

    function test_FactoryMarksSplitter() public {
        (address[] memory rs, uint16[] memory ss) = _two(a, 5000, b, 5000);
        CreatorSplitter s = _mk(rs, ss);
        assertTrue(factory.isSplitter(address(s)));
        assertEq(factory.creatorOf(address(s)), address(this));
    }
}
