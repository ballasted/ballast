// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BuybackBurnerV2} from "../src/BuybackBurnerV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

// A stand-in for BallastHook's fee ledger (same shape as BuybackBurner.t.sol's
// MockClaimHook): claim() pays out its owed WETH to the caller, owed() reports it.
contract MockClaimHookV2 {
    MockERC20 public weth;
    uint256 public owedAmt;
    uint256 public claimCount;

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
        claimCount++;
        uint256 a = owedAmt;
        owedAmt = 0;
        if (a > 0) weth.mint(msg.sender, a);
        return a;
    }
}

// A malicious "hook" whose claim() tries to re-enter the burner. Used to prove
// the nonReentrant guard on claimFees() actually holds.
contract ReentrantClaimHook {
    BuybackBurnerV2 public target;
    bool public attacked;

    function setTarget(BuybackBurnerV2 t) external {
        target = t;
    }

    function owed(address) external view returns (uint256) {
        return attacked ? 0 : 1; // only non-zero before the reentrant attempt
    }

    function claim() external returns (uint256) {
        attacked = true;
        target.claimFees(); // must revert — nonReentrant guard already held
        return 0;
    }
}

/// @notice Constructor validation + access-surface + claimFees tests that don't
/// need a real pool or an RPC (those live in BuybackBurnerV2Fork.t.sol, which
/// proves the actual swap path, including claimFees feeding a real buyback,
/// against BALLAST v2's real live pools). This file locks down the things a
/// fork test can't cheaply assert: that every guard fires BEFORE any external
/// call, that the contract has no owner-gated surface, and that the
/// permissionless fee-pull is sound in isolation.
contract BuybackBurnerV2Test is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address ballast = makeAddr("ballast");
    MockERC20 wethToken;
    address weth;
    address nvda = makeAddr("nvda");
    address anyone = makeAddr("anyone");

    address[] NO_HOOKS;

    function setUp() public {
        wethToken = new MockERC20("Wrapped ETH", "WETH", 18);
        weth = address(wethToken);
    }

    function _key(address quote) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(quote),
            currency1: Currency.wrap(ballast),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    function test_constructor_zeroAddress_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), address(0), weth, nvda, wk, nk, 1, 1, 1, 1000, NO_HOOKS);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, address(0), nvda, wk, nk, 1, 1, 1, 1000, NO_HOOKS);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, address(0), wk, nk, 1, 1, 1, 1000, NO_HOOKS);
    }

    function test_constructor_zeroAddressInClaimHooks_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        address[] memory hooks = new address[](2);
        hooks[0] = makeAddr("realHook");
        hooks[1] = address(0);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 1000, hooks);
    }

    function test_constructor_zeroValue_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 0, 1, 1, 1000, NO_HOOKS);
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 0, 1, 1000, NO_HOOKS);
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 0, 1000, NO_HOOKS);
    }

    function test_constructor_slippageAboveHardCeiling_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.SlippageTooHigh.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 2001, NO_HOOKS);
    }

    function test_constructor_slippageAtHardCeiling_succeeds() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        BuybackBurnerV2 bb =
            new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 2000, NO_HOOKS);
        assertEq(bb.maxSlippageBps(), 2000);
    }

    function test_unsupportedAsset_revertsBeforeAnyExternalCall() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000, NO_HOOKS
        );
        // No tokens minted anywhere, no PoolManager mocked -- if this reverted
        // anywhere other than the very first check, it would revert with a
        // different (unmocked-call) error instead of the specific one below.
        vm.expectRevert(BuybackBurnerV2.UnsupportedAsset.selector);
        bb.buybackAndBurn(makeAddr("randomToken"), 1, 0);
    }

    function test_noOwnerGatedFunctionExists() public {
        // There is no `owner()` on this contract at all -- Ownable was never
        // imported. This test exists to make that fact explicit and
        // regression-proof: if BuybackBurnerV2 ever gains an owner, this line
        // stops compiling (owner() doesn't exist today) rather than silently
        // passing.
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        BuybackBurnerV2 bb =
            new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 1000, NO_HOOKS);
        // Every parameter is a public IMMUTABLE with no setter -- this compiles
        // BECAUSE there is no owner()/setX() to accidentally call instead.
        assertEq(bb.maxWethPerCall(), 1);
        assertEq(bb.maxNvdaPerCall(), 1);
        assertEq(bb.cooldownSeconds(), 1);
    }

    function test_buybackAndBurn_zeroBalance_reverts_evenWithClaimHooksConfigured() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        MockClaimHookV2 hook = new MockClaimHookV2(wethToken); // owed = 0 by default
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000, hooks
        );
        // Nothing held, nothing claimable -- reverts before ever reaching PoolManager.
        vm.prank(anyone);
        vm.expectRevert(BuybackBurnerV2.NothingToSpend.selector);
        bb.buybackAndBurn(weth, 1 ether, 0);
    }

    // ── claimFees: permissionless pull, in isolation (no pool needed) ──────────

    function test_claimFees_emptyHooks_isNoOp() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        BuybackBurnerV2 bb =
            new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 1000, NO_HOOKS);
        vm.prank(anyone);
        assertEq(bb.claimFees(), 0);
        assertEq(wethToken.balanceOf(address(bb)), 0);
    }

    function test_claimFees_permissionless_pullsFromConfiguredHooks() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        MockClaimHookV2 hookA = new MockClaimHookV2(wethToken);
        MockClaimHookV2 hookB = new MockClaimHookV2(wethToken);
        hookA.setOwed(0.3 ether);
        hookB.setOwed(0.7 ether);
        address[] memory hooks = new address[](2);
        hooks[0] = address(hookA);
        hooks[1] = address(hookB);
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000, hooks
        );

        vm.prank(anyone); // permissionless -- not a deployer/owner-only call
        uint256 claimed = bb.claimFees();

        assertEq(claimed, 1 ether, "sums across every configured hook");
        assertEq(wethToken.balanceOf(address(bb)), 1 ether);
        assertEq(hookA.owedAmt(), 0);
        assertEq(hookB.owedAmt(), 0);
    }

    function test_claimFees_skipsHooksWithZeroOwed_doesNotCallClaimOnThem() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        MockClaimHookV2 empty = new MockClaimHookV2(wethToken); // owed = 0
        MockClaimHookV2 funded = new MockClaimHookV2(wethToken);
        funded.setOwed(0.5 ether);
        address[] memory hooks = new address[](2);
        hooks[0] = address(empty);
        hooks[1] = address(funded);
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000, hooks
        );

        bb.claimFees();
        assertEq(empty.claimCount(), 0, "claim() never called on a hook owing nothing");
        assertEq(funded.claimCount(), 1);
    }

    function test_claimFees_accruedWethView_sumsHeldAndClaimable() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        MockClaimHookV2 hook = new MockClaimHookV2(wethToken);
        hook.setOwed(0.4 ether);
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000, hooks
        );
        wethToken.mint(address(bb), 0.1 ether);

        assertEq(bb.accruedWeth(), 0.5 ether);
        assertEq(bb.claimHooksLength(), 1);
    }

    function test_claimFees_reentrantHook_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        ReentrantClaimHook hook = new ReentrantClaimHook();
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000, hooks
        );
        hook.setTarget(bb);

        // The hook's claim() tries to re-enter bb.claimFees() while the guard is
        // already held -- the whole outer call must revert, not just the inner one.
        vm.expectRevert();
        bb.claimFees();
    }
}
