// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

// A stand-in for BallastHook's fee ledger: claim() mints its owed WETH to the caller.
contract MockClaimHook {
    MockERC20 public weth;
    uint256 public owedAmt;

    constructor(MockERC20 w) {
        weth = w;
    }

    function setOwed(uint256 a) external {
        owedAmt = a;
    }

    function owed(address) external view returns (uint256) {
        return owedAmt;
    }

    function claim() external returns (uint256) {
        uint256 a = owedAmt;
        owedAmt = 0;
        if (a > 0) weth.mint(msg.sender, a);
        return a;
    }
}

// A hostile "hook" whose claim() reenters distribute() — must be blocked by the guard.
contract ReentrantHook {
    FeeSplitter public s;

    function set(FeeSplitter s_) external {
        s = s_;
    }

    function owed(address) external pure returns (uint256) {
        return 0;
    }

    function claim() external returns (uint256) {
        s.distribute(); // reentrancy attempt
        return 0;
    }
}

// Adversarial-first (CLAUDE.md). This contract holds fee WETH, so the invariants that
// matter are: the buyback's cut can't be redirected, the split can't be silently
// starved to one side, the maths lose no wei, and there is no withdrawal path.
contract FeeSplitterTest is Test {
    FeeSplitter sp;
    MockERC20 weth;
    MockClaimHook hook;

    address owner = makeAddr("owner");
    address safe = makeAddr("safe");
    address attacker = makeAddr("attacker");
    address anyone = makeAddr("anyone");
    address buyback = makeAddr("buyback");
    address platform = makeAddr("platform"); // stands in for 0x3b4f

    uint16 constant BPS35 = 3_500;

    function setUp() public {
        weth = new MockERC20("Wrapped ETH", "WETH", 18);
        hook = new MockClaimHook(weth);
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        sp = new FeeSplitter(address(weth), buyback, platform, BPS35, hooks, owner);
    }

    // ── Construction guards ──────────────────────────────────────────────────────

    function test_constructor_rejectsZeroAddresses() public {
        address[] memory h = new address[](0);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        new FeeSplitter(address(0), buyback, platform, BPS35, h, owner);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        new FeeSplitter(address(weth), address(0), platform, BPS35, h, owner);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        new FeeSplitter(address(weth), buyback, address(0), BPS35, h, owner);
    }

    function test_constructor_enforcesBpsBounds() public {
        address[] memory h = new address[](0);
        vm.expectRevert(FeeSplitter.BpsOutOfBounds.selector);
        new FeeSplitter(address(weth), buyback, platform, 999, h, owner); // < 10%
        vm.expectRevert(FeeSplitter.BpsOutOfBounds.selector);
        new FeeSplitter(address(weth), buyback, platform, 9001, h, owner); // > 90%
    }

    // ── The core split ───────────────────────────────────────────────────────────

    function test_distribute_splits35_65_andSweepsHook() public {
        weth.mint(address(sp), 0.5 ether); // already held
        hook.setOwed(0.5 ether); // still claimable → 1 ether total

        vm.prank(anyone); // permissionless
        (uint256 toB, uint256 toP) = sp.distribute();

        assertEq(toB, 0.35 ether, "35% to buyback");
        assertEq(toP, 0.65 ether, "65% to platform");
        assertEq(IERC20(weth).balanceOf(buyback), 0.35 ether);
        assertEq(IERC20(weth).balanceOf(platform), 0.65 ether);
        assertEq(IERC20(weth).balanceOf(address(sp)), 0, "splitter keeps nothing");
        assertEq(sp.totalToBuyback(), 0.35 ether);
        assertEq(sp.totalToPlatform(), 0.65 ether);
    }

    // No wei may be lost to rounding: toBuyback + toPlatform must equal the whole balance.
    function testFuzz_distribute_losesNoWei(uint96 amount, uint16 bpsSeed) public {
        uint256 bal = uint256(amount) + 1; // 1 wei .. ~7.9e28
        uint16 bps = uint16(bound(bpsSeed, sp.MIN_BUYBACK_BPS(), sp.MAX_BUYBACK_BPS()));
        vm.prank(owner);
        sp.setBuybackBps(bps);

        weth.mint(address(sp), bal);
        vm.prank(anyone);
        (uint256 toB, uint256 toP) = sp.distribute();

        assertEq(toB + toP, bal, "every wei accounted for");
        assertEq(IERC20(weth).balanceOf(buyback) + IERC20(weth).balanceOf(platform), bal);
        assertEq(IERC20(weth).balanceOf(address(sp)), 0);
    }

    function test_distribute_revertsWhenEmpty() public {
        vm.prank(anyone);
        vm.expectRevert(FeeSplitter.NothingToDistribute.selector);
        sp.distribute();
    }

    // ── The buyback cut is nailed to a fixed address ───────────────────────────────

    function test_buybackAddress_isImmutable() public view {
        // There is no setter for `buyback`; it is `immutable`. This asserts the value and
        // documents the invariant — the burn-bound share can never be pointed elsewhere.
        assertEq(sp.buyback(), buyback);
    }

    function test_ownerCanRetargetOnlyThePlatformShare() public {
        vm.prank(owner);
        sp.setPlatformRecipient(safe); // platform's own 65% can move (e.g. to a Safe)

        weth.mint(address(sp), 1 ether);
        vm.prank(anyone);
        sp.distribute();

        assertEq(IERC20(weth).balanceOf(safe), 0.65 ether, "platform share follows recipient");
        assertEq(IERC20(weth).balanceOf(buyback), 0.35 ether, "buyback share still to the fixed buyback");
    }

    // ── Access control + bounds on the tunables ────────────────────────────────────

    function test_setters_onlyOwner() public {
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        sp.setBuybackBps(5000);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        sp.setPlatformRecipient(attacker);
        address[] memory h = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        sp.setClaimHooks(h);
        vm.stopPrank();
    }

    function test_setBuybackBps_cannotStarveEitherSide() public {
        vm.startPrank(owner);
        vm.expectRevert(FeeSplitter.BpsOutOfBounds.selector);
        sp.setBuybackBps(999); // would push platform to 90.01% — rejected
        vm.expectRevert(FeeSplitter.BpsOutOfBounds.selector);
        sp.setBuybackBps(9001); // would push buyback to 90.01% — rejected
        sp.setBuybackBps(1000); // 10% ok
        assertEq(sp.buybackBps(), 1000);
        sp.setBuybackBps(9000); // 90% ok
        assertEq(sp.buybackBps(), 9000);
        vm.stopPrank();
    }

    function test_setPlatformRecipient_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        sp.setPlatformRecipient(address(0));
    }

    // ── Reentrancy ─────────────────────────────────────────────────────────────────

    function test_distribute_reentrancyBlocked() public {
        ReentrantHook rh = new ReentrantHook();
        rh.set(sp);
        address[] memory hooks = new address[](1);
        hooks[0] = address(rh);
        vm.prank(owner);
        sp.setClaimHooks(hooks);

        weth.mint(address(sp), 1 ether);
        vm.prank(anyone);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        sp.distribute();
    }

    // ── Ownership handoff ────────────────────────────────────────────────────────

    function test_twoStepOwnership() public {
        vm.prank(owner);
        sp.transferOwnership(safe);
        assertEq(sp.owner(), owner);
        assertEq(sp.pendingOwner(), safe);
        vm.prank(safe);
        sp.acceptOwnership();
        assertEq(sp.owner(), safe);
    }
}
