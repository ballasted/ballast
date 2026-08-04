// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

// A stand-in for BallastHook's fee ledger: claim() pays out its owed WETH to the
// caller (minting, to simulate the hook's WETH transfer); owed() reports the balance.
contract MockClaimHook {
    MockERC20 public weth;
    uint256 public owedAmt;
    bool public claimed;

    constructor(MockERC20 weth_) {
        weth = weth_;
    }

    function setOwed(uint256 a) external {
        owedAmt = a;
    }

    function owed(address) external view returns (uint256) {
        return owedAmt;
    }

    function claim() external returns (uint256) {
        claimed = true;
        uint256 a = owedAmt;
        owedAmt = 0;
        if (a > 0) weth.mint(msg.sender, a);
        return a;
    }
}

// Adversarial-first (CLAUDE.md). The swap itself is exercised on a mainnet fork
// (BuybackBurnerFork.t.sol / manual verification); here we lock down access control,
// the threshold gate, the slippage-bound cap, ownership handoff, and the accounting —
// everything that must hold regardless of the pool.
contract BuybackBurnerTest is Test {
    BuybackBurner bb;
    MockERC20 weth;
    MockERC20 ballast;
    MockClaimHook hook;

    address owner = makeAddr("owner");
    address safe = makeAddr("safe");
    address attacker = makeAddr("attacker");
    address anyone = makeAddr("anyone");

    uint256 constant THRESHOLD = 1 ether;
    uint16 constant SLIPPAGE = 500; // 5%

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(ballast)),
            currency1: Currency.wrap(address(weth)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    function setUp() public {
        weth = new MockERC20("Wrapped ETH", "WETH", 18);
        ballast = new MockERC20("Ballast", "BALLAST", 18);
        hook = new MockClaimHook(weth);
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        bb = new BuybackBurner(
            IPoolManager(address(0)), address(weth), address(ballast), _poolKey(), hooks, THRESHOLD, SLIPPAGE, owner
        );
    }

    // ── Construction guards ─────────────────────────────────────────────────────

    function test_constructor_rejectsHighSlippage() public {
        address[] memory hooks = new address[](0);
        vm.expectRevert(BuybackBurner.SlippageTooHigh.selector);
        new BuybackBurner(
            IPoolManager(address(0)), address(weth), address(ballast), _poolKey(), hooks, THRESHOLD, 2001, owner
        );
    }

    function test_constructor_rejectsZeroToken() public {
        address[] memory hooks = new address[](0);
        vm.expectRevert(BuybackBurner.ZeroAddress.selector);
        new BuybackBurner(
            IPoolManager(address(0)), address(0), address(ballast), _poolKey(), hooks, THRESHOLD, SLIPPAGE, owner
        );
    }

    // ── Access control ──────────────────────────────────────────────────────────

    function test_setters_onlyOwner() public {
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        bb.setThreshold(2 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        bb.setMaxSlippageBps(100);
        address[] memory hooks = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        bb.setClaimHooks(hooks);
        vm.stopPrank();
    }

    function test_setMaxSlippage_cap() public {
        vm.prank(owner);
        vm.expectRevert(BuybackBurner.SlippageTooHigh.selector);
        bb.setMaxSlippageBps(2001);

        vm.prank(owner);
        bb.setMaxSlippageBps(2000);
        assertEq(bb.maxSlippageBps(), 2000);
    }

    function test_setThreshold_works() public {
        vm.prank(owner);
        bb.setThreshold(5 ether);
        assertEq(bb.threshold(), 5 ether);
    }

    // ── No withdrawal path ──────────────────────────────────────────────────────
    // There is deliberately no function that moves WETH or $BALLAST out except the
    // buyback→burn path. This is a design invariant; the absence is asserted by the
    // ABI having no such entrypoint (compile-time), and by the owner being unable to
    // reach the funds through any setter above.

    // ── Threshold gate ──────────────────────────────────────────────────────────

    function test_buyback_belowThreshold_reverts() public {
        // Held + claimable is under the threshold, so a (permissionless) buyback
        // reverts cleanly before moving any funds — the fees stay put for later.
        weth.mint(address(bb), 0.2 ether); // held
        hook.setOwed(0.4 ether); // claimable
        vm.prank(anyone); // permissionless — not the owner
        vm.expectRevert(abi.encodeWithSelector(BuybackBurner.BelowThreshold.selector, 0.6 ether, THRESHOLD));
        bb.buybackAndBurn();
        assertFalse(hook.claimed(), "must not claim when below threshold");
        assertEq(weth.balanceOf(address(bb)), 0.2 ether, "held WETH untouched");
    }

    // ── Views ───────────────────────────────────────────────────────────────────

    function test_accruedWeth_sumsHeldAndOwed() public {
        weth.mint(address(bb), 0.7 ether);
        hook.setOwed(0.9 ether);
        assertEq(bb.accruedWeth(), 1.6 ether);
    }

    function test_burnedBalance_readsDeadAddress() public {
        ballast.mint(bb.DEAD(), 123 ether);
        assertEq(bb.burnedBalance(), 123 ether);
    }

    function test_dead_isNonzeroDeadAddress() public view {
        assertEq(bb.DEAD(), 0x000000000000000000000000000000000000dEaD);
    }

    // ── Ownership handoff to the Safe ─────────────────────────────────────────────

    function test_twoStepOwnership() public {
        vm.prank(owner);
        bb.transferOwnership(safe);
        assertEq(bb.owner(), owner); // unchanged until accepted
        assertEq(bb.pendingOwner(), safe);

        vm.prank(safe);
        bb.acceptOwnership();
        assertEq(bb.owner(), safe);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        bb.setThreshold(9 ether);
    }
}
