// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BuybackBurnerV2} from "../src/BuybackBurnerV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

// A stand-in for BallastHook's two fee ledgers: `owed`/`claim()` (WETH-shaped,
// single balance) and `owedIn`/`claimIn(asset)` (one balance per asset, mirrors
// the real hook's per-currency ledger used for NVDA and every other quote asset).
contract MockClaimHookV2 {
    MockERC20 public weth;
    uint256 public owedAmt;
    uint256 public claimCount;

    mapping(address => uint256) public owedInAmt;
    mapping(address => uint256) public claimInCount;

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

    function setOwedIn(address asset, uint256 a) external {
        owedInAmt[asset] = a;
    }

    function owedIn(address, address asset) external view returns (uint256) {
        return owedInAmt[asset];
    }

    function claimIn(address asset) external returns (uint256) {
        claimInCount[asset]++;
        uint256 a = owedInAmt[asset];
        owedInAmt[asset] = 0;
        if (a > 0) MockERC20(asset).mint(msg.sender, a);
        return a;
    }
}

// A malicious "hook" whose claim() tries to re-enter the burner via claimFees().
// Used to prove the nonReentrant guard on claimFees() actually holds. Only the
// WETH-shaped ledger is exercised before the revert propagates, so owedIn/claimIn
// are never reached here -- not implemented, matching the real attack surface.
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

// Same idea, for the owedIn/claimIn path specifically -- proves claimOtherFees'
// own nonReentrant guard holds.
contract ReentrantClaimInHook {
    BuybackBurnerV2 public target;
    address public asset;
    bool public attacked;

    function setTarget(BuybackBurnerV2 t, address asset_) external {
        target = t;
        asset = asset_;
    }

    function owed(address) external pure returns (uint256) {
        return 0;
    }

    function claim() external pure returns (uint256) {
        return 0;
    }

    function owedIn(address, address) external view returns (uint256) {
        return attacked ? 0 : 1;
    }

    function claimIn(address) external returns (uint256) {
        attacked = true;
        target.claimOtherFees(asset); // must revert — nonReentrant guard already held
        return 0;
    }
}

/// @notice Constructor validation + access-surface + claimFees/claimOtherFees tests
/// that don't need a real pool or an RPC (those live in BuybackBurnerV2Fork.t.sol,
/// which proves the actual swap path, the real NVDA claim path, and a real
/// claimOtherFees forward, against BALLAST v2's real live pools and the real hook).
/// This file locks down the things a fork test can't cheaply assert: that every
/// guard fires BEFORE any external call, that the contract has no owner-gated
/// surface, and that the permissionless fee-pull/forward logic is sound in
/// isolation.
contract BuybackBurnerV2Test is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address ballast = makeAddr("ballast");
    MockERC20 wethToken;
    address weth;
    address nvda = makeAddr("nvda");
    address anyone = makeAddr("anyone");
    address fallbackRecipient = makeAddr("fallbackRecipient");

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

    function _deploy(address[] memory hooks) internal returns (BuybackBurnerV2 bb) {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000, hooks, fallbackRecipient
        );
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    function test_constructor_zeroAddress_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), address(0), weth, nvda, wk, nk, 1, 1, 1, 1000, NO_HOOKS, fallbackRecipient
        );
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, address(0), nvda, wk, nk, 1, 1, 1, 1000, NO_HOOKS, fallbackRecipient
        );
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, address(0), wk, nk, 1, 1, 1, 1000, NO_HOOKS, fallbackRecipient
        );
    }

    function test_constructor_zeroFallbackRecipient_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 1000, NO_HOOKS, address(0)
        );
    }

    function test_constructor_zeroAddressInClaimHooks_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        address[] memory hooks = new address[](2);
        hooks[0] = makeAddr("realHook");
        hooks[1] = address(0);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 1000, hooks, fallbackRecipient
        );
    }

    function test_constructor_zeroValue_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 0, 1, 1, 1000, NO_HOOKS, fallbackRecipient
        );
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 0, 1, 1000, NO_HOOKS, fallbackRecipient
        );
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 0, 1000, NO_HOOKS, fallbackRecipient
        );
    }

    function test_constructor_slippageAboveHardCeiling_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.SlippageTooHigh.selector);
        new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 2001, NO_HOOKS, fallbackRecipient
        );
    }

    function test_constructor_slippageAtHardCeiling_succeeds() public {
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        assertEq(bb.maxSlippageBps(), 1000);
        assertEq(bb.fallbackRecipient(), fallbackRecipient);
    }

    function test_unsupportedAsset_revertsBeforeAnyExternalCall() public {
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
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
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        // Every parameter is a public IMMUTABLE with no setter -- this compiles
        // BECAUSE there is no owner()/setX() to accidentally call instead.
        assertEq(bb.maxWethPerCall(), 1 ether);
        assertEq(bb.maxNvdaPerCall(), 1 ether);
        assertEq(bb.cooldownSeconds(), 1 hours);
    }

    function test_buybackAndBurn_zeroBalance_reverts_evenWithClaimHooksConfigured() public {
        MockClaimHookV2 hook = new MockClaimHookV2(wethToken); // owed = 0 by default
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = _deploy(hooks);
        // Nothing held, nothing claimable -- reverts before ever reaching PoolManager.
        vm.prank(anyone);
        vm.expectRevert(BuybackBurnerV2.NothingToSpend.selector);
        bb.buybackAndBurn(weth, 1 ether, 0);
    }

    // ── claimFees: permissionless pull of WETH + NVDA, in isolation ─────────────

    function test_claimFees_emptyHooks_isNoOp() public {
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        vm.prank(anyone);
        (uint256 w, uint256 n) = bb.claimFees();
        assertEq(w, 0);
        assertEq(n, 0);
        assertEq(wethToken.balanceOf(address(bb)), 0);
    }

    function test_claimFees_permissionless_pullsWethFromConfiguredHooks() public {
        MockClaimHookV2 hookA = new MockClaimHookV2(wethToken);
        MockClaimHookV2 hookB = new MockClaimHookV2(wethToken);
        hookA.setOwed(0.3 ether);
        hookB.setOwed(0.7 ether);
        address[] memory hooks = new address[](2);
        hooks[0] = address(hookA);
        hooks[1] = address(hookB);
        BuybackBurnerV2 bb = _deploy(hooks);

        vm.prank(anyone); // permissionless -- not a deployer/owner-only call
        (uint256 wethClaimed, uint256 nvdaClaimed) = bb.claimFees();

        assertEq(wethClaimed, 1 ether, "sums across every configured hook");
        assertEq(nvdaClaimed, 0, "no owedIn(nvda) configured on either mock hook");
        assertEq(wethToken.balanceOf(address(bb)), 1 ether);
        assertEq(hookA.owedAmt(), 0);
        assertEq(hookB.owedAmt(), 0);
    }

    function test_claimFees_permissionless_pullsNvdaViaOwedInClaimIn() public {
        MockERC20 nvdaToken = new MockERC20("NVDA", "NVDA", 18);
        MockClaimHookV2 hook = new MockClaimHookV2(wethToken);
        hook.setOwedIn(address(nvdaToken), 2 ether);
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(address(nvdaToken));
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER),
            ballast,
            weth,
            address(nvdaToken),
            wk,
            nk,
            1 ether,
            1 ether,
            1 hours,
            1000,
            hooks,
            fallbackRecipient
        );

        vm.prank(anyone);
        (uint256 wethClaimed, uint256 nvdaClaimed) = bb.claimFees();

        assertEq(wethClaimed, 0);
        assertEq(nvdaClaimed, 2 ether, "pulled via owedIn(this, nvda)/claimIn(nvda), not owed()/claim()");
        assertEq(nvdaToken.balanceOf(address(bb)), 2 ether);
        assertEq(hook.claimInCount(address(nvdaToken)), 1);
        assertEq(hook.claimCount(), 0, "the WETH-shaped claim() must never be called for this");
    }

    function test_claimFees_skipsHooksWithZeroOwed_doesNotCallClaimOnThem() public {
        MockClaimHookV2 empty = new MockClaimHookV2(wethToken); // owed = 0
        MockClaimHookV2 funded = new MockClaimHookV2(wethToken);
        funded.setOwed(0.5 ether);
        address[] memory hooks = new address[](2);
        hooks[0] = address(empty);
        hooks[1] = address(funded);
        BuybackBurnerV2 bb = _deploy(hooks);

        bb.claimFees();
        assertEq(empty.claimCount(), 0, "claim() never called on a hook owing nothing");
        assertEq(funded.claimCount(), 1);
    }

    function test_claimFees_accruedWethAndNvdaViews_sumHeldAndClaimable() public {
        MockERC20 nvdaToken = new MockERC20("NVDA", "NVDA", 18);
        MockClaimHookV2 hook = new MockClaimHookV2(wethToken);
        hook.setOwed(0.4 ether);
        hook.setOwedIn(address(nvdaToken), 0.9 ether);
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(address(nvdaToken));
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER),
            ballast,
            weth,
            address(nvdaToken),
            wk,
            nk,
            1 ether,
            1 ether,
            1 hours,
            1000,
            hooks,
            fallbackRecipient
        );
        wethToken.mint(address(bb), 0.1 ether);
        nvdaToken.mint(address(bb), 0.2 ether);

        assertEq(bb.accruedWeth(), 0.5 ether);
        assertEq(bb.accruedNvda(), 1.1 ether);
        assertEq(bb.claimHooksLength(), 1);
    }

    function test_claimFees_reentrantHook_reverts() public {
        ReentrantClaimHook hook = new ReentrantClaimHook();
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = _deploy(hooks);
        hook.setTarget(bb);

        // The hook's claim() tries to re-enter bb.claimFees() while the guard is
        // already held -- the whole outer call must revert, not just the inner one.
        vm.expectRevert();
        bb.claimFees();
    }

    // ── claimOtherFees: every non-WETH/non-NVDA asset, forwarded whole ─────────

    function test_claimOtherFees_revertsForWeth() public {
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        vm.expectRevert(BuybackBurnerV2.CannotForwardThisAsset.selector);
        bb.claimOtherFees(weth);
    }

    function test_claimOtherFees_revertsForNvda() public {
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        vm.expectRevert(BuybackBurnerV2.CannotForwardThisAsset.selector);
        bb.claimOtherFees(nvda);
    }

    function test_claimOtherFees_revertsForBallast() public {
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        vm.expectRevert(BuybackBurnerV2.CannotForwardThisAsset.selector);
        bb.claimOtherFees(ballast);
    }

    function test_claimOtherFees_nothingToForward_reverts() public {
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        MockERC20 sgov = new MockERC20("SGOV", "SGOV", 18); // real contract, zero balance here
        vm.expectRevert(BuybackBurnerV2.NothingToForward.selector);
        bb.claimOtherFees(address(sgov));
    }

    function test_claimOtherFees_pullsFromHooksAndForwardsWhole_toFallbackRecipient() public {
        MockERC20 sgov = new MockERC20("SGOV", "SGOV", 18);
        MockClaimHookV2 hookA = new MockClaimHookV2(wethToken);
        MockClaimHookV2 hookB = new MockClaimHookV2(wethToken);
        hookA.setOwedIn(address(sgov), 3 ether);
        hookB.setOwedIn(address(sgov), 7 ether);
        address[] memory hooks = new address[](2);
        hooks[0] = address(hookA);
        hooks[1] = address(hookB);
        BuybackBurnerV2 bb = _deploy(hooks);

        vm.prank(anyone); // permissionless
        uint256 forwarded = bb.claimOtherFees(address(sgov));

        assertEq(forwarded, 10 ether, "sums across every configured hook");
        assertEq(sgov.balanceOf(fallbackRecipient), 10 ether);
        assertEq(sgov.balanceOf(address(bb)), 0, "never held here, forwarded immediately");
        assertEq(bb.totalForwarded(address(sgov)), 10 ether);
    }

    function test_claimOtherFees_directDonation_isForwardable() public {
        MockERC20 sgov = new MockERC20("SGOV", "SGOV", 18);
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        sgov.mint(address(bb), 5 ether); // a plain transfer in, no hook involved

        uint256 forwarded = bb.claimOtherFees(address(sgov));

        assertEq(forwarded, 5 ether);
        assertEq(sgov.balanceOf(fallbackRecipient), 5 ether);
    }

    function test_claimOtherFees_combinesClaimedAndDonatedBalance() public {
        MockERC20 sgov = new MockERC20("SGOV", "SGOV", 18);
        MockClaimHookV2 hook = new MockClaimHookV2(wethToken);
        hook.setOwedIn(address(sgov), 4 ether);
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = _deploy(hooks);
        sgov.mint(address(bb), 1 ether); // plus a direct donation

        uint256 forwarded = bb.claimOtherFees(address(sgov));

        assertEq(forwarded, 5 ether, "claimed + donated, all forwarded together");
        assertEq(sgov.balanceOf(fallbackRecipient), 5 ether);
    }

    function test_claimOtherFeesView_totalForwarded_accumulatesAcrossCalls() public {
        MockERC20 sgov = new MockERC20("SGOV", "SGOV", 18);
        BuybackBurnerV2 bb = _deploy(NO_HOOKS);
        sgov.mint(address(bb), 2 ether);
        bb.claimOtherFees(address(sgov));
        sgov.mint(address(bb), 3 ether);
        bb.claimOtherFees(address(sgov));

        assertEq(bb.totalForwarded(address(sgov)), 5 ether);
        assertEq(sgov.balanceOf(fallbackRecipient), 5 ether);
    }

    function test_claimOtherFees_reentrantHook_reverts() public {
        MockERC20 sgov = new MockERC20("SGOV", "SGOV", 18);
        ReentrantClaimInHook hook = new ReentrantClaimInHook();
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = _deploy(hooks);
        hook.setTarget(bb, address(sgov));

        vm.expectRevert();
        bb.claimOtherFees(address(sgov));
    }
}
